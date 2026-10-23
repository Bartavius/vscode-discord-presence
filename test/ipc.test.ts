import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { buildActivity } from '../src/activity.ts';
import {
	DiscordIpc,
	encodeFrame,
	FrameDecoder,
	ipcPaths,
	isSafeDirectory,
	MAX_FRAME_BYTES,
	Op,
	resolveTrustedSocket,
	type Frame,
} from '../src/ipc.ts';

test('encodes the header as opcode and body length, little-endian', () => {
	const frame = encodeFrame(Op.Frame, { a: 1 });
	assert.equal(frame.readUInt32LE(0), Op.Frame);
	assert.equal(frame.readUInt32LE(4), frame.length - 8);
	assert.deepEqual(JSON.parse(frame.subarray(8).toString()), { a: 1 });
});

test('reassembles frames split byte by byte', () => {
	const decoder = new FrameDecoder();
	const bytes = encodeFrame(Op.Frame, { hello: 'world' });
	const frames: Frame[] = [];
	for (const byte of bytes) frames.push(...decoder.push(Buffer.from([byte])));
	assert.deepEqual(frames, [{ op: Op.Frame, data: { hello: 'world' } }]);
});

test('splits several frames that arrive in one chunk', () => {
	const decoder = new FrameDecoder();
	const chunk = Buffer.concat([encodeFrame(Op.Ping, 1), encodeFrame(Op.Frame, 2)]);
	assert.deepEqual(decoder.push(chunk), [
		{ op: Op.Ping, data: 1 },
		{ op: Op.Frame, data: 2 },
	]);
});

test('rejects an oversized frame from its header alone', () => {
	const header = Buffer.alloc(8);
	header.writeUInt32LE(Op.Frame, 0);
	header.writeUInt32LE(MAX_FRAME_BYTES + 1, 4);
	assert.throws(() => new FrameDecoder().push(header), /exceeds limit/);
});

test('rejects a body that is not JSON', () => {
	const body = Buffer.from('not json');
	const header = Buffer.alloc(8);
	header.writeUInt32LE(Op.Frame, 0);
	header.writeUInt32LE(body.length, 4);
	assert.throws(() => new FrameDecoder().push(Buffer.concat([header, body])), SyntaxError);
});

test('lists socket paths per platform', () => {
	assert.equal(ipcPaths('win32', 'ignored')[0], '\\\\?\\pipe\\discord-ipc-0');
	assert.deepEqual(ipcPaths('darwin', '/run').slice(0, 2), ['/run/discord-ipc-0', '/run/discord-ipc-1']);
	assert.equal(ipcPaths('darwin', '/run').length, 10);
	assert.ok(ipcPaths('linux', '/run').includes('/run/app/com.discordapp.Discord/discord-ipc-0'));
});

// End-to-end against a fake Discord listening on a Unix socket.
const dir = mkdtempSync(path.join(tmpdir(), 'dp-'));
after(() => rmSync(dir, { recursive: true, force: true }));

interface FakeDiscord {
	received: Frame[];
	client: Promise<net.Socket>;
	close: () => Promise<void>;
}

async function fakeDiscord(name: string, onFrame: (socket: net.Socket, frame: Frame) => void): Promise<FakeDiscord> {
	const received: Frame[] = [];
	let accept!: (socket: net.Socket) => void;
	const client = new Promise<net.Socket>((resolve) => (accept = resolve));
	const server = net.createServer((socket) => {
		accept(socket);
		const decoder = new FrameDecoder();
		socket.on('data', (chunk: Buffer) => {
			for (const frame of decoder.push(chunk)) {
				received.push(frame);
				onFrame(socket, frame);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(path.join(dir, name), resolve));
	return {
		received,
		client,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
				void client.then((socket) => socket.destroy());
			}),
	};
}

const sendReady = (socket: net.Socket, frame: Frame) => {
	if (frame.op === Op.Handshake) socket.write(encodeFrame(Op.Frame, { cmd: 'DISPATCH', evt: 'READY', data: {} }));
};

test('handshakes, waits for READY, then sends SET_ACTIVITY', async () => {
	const discord = await fakeDiscord('ready', sendReady);
	const ipc = new DiscordIpc('123456789012345678', () => {});
	await ipc.connect([path.join(dir, 'missing'), path.join(dir, 'ready')], 2_000);

	const activity = buildActivity({ languageId: 'rust', debugging: false, showLanguage: true, startedAt: 1 });
	ipc.setActivity(activity);
	await waitFor(() => discord.received.length === 2);

	assert.deepEqual(discord.received[0], { op: Op.Handshake, data: { v: 1, client_id: '123456789012345678' } });
	const sent = discord.received[1]?.data as { cmd: string; args: unknown };
	assert.equal(sent.cmd, 'SET_ACTIVITY');
	assert.deepEqual(sent.args, { pid: process.pid, activity });

	ipc.close();
	await discord.close();
});

test('answers PING with PONG', async () => {
	const discord = await fakeDiscord('ping', sendReady);
	const ipc = new DiscordIpc('123456789012345678', () => {});
	await ipc.connect([path.join(dir, 'ping')], 2_000);
	(await discord.client).write(encodeFrame(Op.Ping, 'abc'));
	await waitFor(() => discord.received.some((f) => f.op === Op.Pong));
	assert.deepEqual(discord.received.at(-1), { op: Op.Pong, data: 'abc' });
	ipc.close();
	await discord.close();
});

test('reports an oversized frame after READY as a disconnect', async () => {
	const discord = await fakeDiscord('oversized', sendReady);
	let reason: string | undefined;
	const ipc = new DiscordIpc('123456789012345678', (r) => (reason = r));
	await ipc.connect([path.join(dir, 'oversized')], 2_000);

	const header = Buffer.alloc(8);
	header.writeUInt32LE(Op.Frame, 0);
	header.writeUInt32LE(0xffffffff, 4);
	(await discord.client).write(header);
	await waitFor(() => reason !== undefined);
	assert.match(reason ?? '', /protocol error/);
	await discord.close();
});

test('rejects when Discord closes the handshake', async () => {
	const discord = await fakeDiscord('rejected', (socket, frame) => {
		if (frame.op === Op.Handshake) socket.write(encodeFrame(Op.Close, { code: 4000, message: 'Invalid Client ID' }));
	});
	const ipc = new DiscordIpc('123456789012345678', () => assert.fail('onClose must not fire before READY'));
	await assert.rejects(ipc.connect([path.join(dir, 'rejected')], 2_000), /Invalid Client ID/);
	await discord.close();
});

test('does not call onClose after close()', async () => {
	const discord = await fakeDiscord('quiet', sendReady);
	const ipc = new DiscordIpc('123456789012345678', () => assert.fail('onClose fired after close()'));
	await ipc.connect([path.join(dir, 'quiet')], 2_000);
	ipc.close();
	await discord.close();
	await new Promise((resolve) => setTimeout(resolve, 50));
});

test('resolves trusted sockets to their real path', async () => {
	const discord = await fakeDiscord('trusted', sendReady);
	const socketPath = path.join(dir, 'trusted');
	const real = realpathSync(socketPath);
	assert.equal(await resolveTrustedSocket(socketPath), real);

	const link = path.join(dir, 'link');
	symlinkSync(socketPath, link);
	assert.equal(await resolveTrustedSocket(link), real, 'symlink resolves to the socket it points at');

	const file = path.join(dir, 'plain-file');
	writeFileSync(file, '');
	assert.equal(await resolveTrustedSocket(file), undefined, 'regular file');

	chmodSync(dir, 0o777);
	try {
		assert.equal(await resolveTrustedSocket(socketPath), undefined, 'world-writable parent');
		chmodSync(dir, 0o1777);
		assert.equal(await resolveTrustedSocket(socketPath), real, 'sticky world-writable parent, like /tmp');
	} finally {
		chmodSync(dir, 0o700);
	}
	await discord.close();
});

test('only trusts directories owned by root or the current user', () => {
	const me = 501;
	const other = 502;
	const directory = (uid: number, mode: number) => ({ uid, mode, isDirectory: () => true });
	assert.equal(isSafeDirectory(directory(0, 0o755), me), true, 'root-owned');
	assert.equal(isSafeDirectory(directory(me, 0o700), me), true, 'mine');
	assert.equal(isSafeDirectory(directory(0, 0o1777), me), true, 'root-owned sticky, like /tmp');
	assert.equal(isSafeDirectory(directory(other, 0o755), me), false, 'owned by another user');
	assert.equal(isSafeDirectory(directory(other, 0o1777), me), false, 'sticky but owned by another user');
	assert.equal(isSafeDirectory(directory(0, 0o777), me), false, 'world-writable');
	assert.equal(isSafeDirectory(directory(0, 0o775), me), false, 'group-writable');
	assert.equal(isSafeDirectory({ uid: me, mode: 0o700, isDirectory: () => false }, me), false, 'not a directory');
});

test('rejects when no socket exists', async () => {
	const ipc = new DiscordIpc('123456789012345678', () => {});
	await assert.rejects(ipc.connect([path.join(dir, 'nothing-here')], 500), /not running/);
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
