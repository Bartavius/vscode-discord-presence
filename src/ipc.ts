import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Activity } from './activity.ts';

// Discord's local RPC protocol: an 8-byte header (opcode, body length; both
// uint32 little-endian) followed by a JSON body.
export const Op = { Handshake: 0, Frame: 1, Close: 2, Ping: 3, Pong: 4 } as const;

// Discord's own frames are a few KB. Anything larger is not buffered.
export const MAX_FRAME_BYTES = 64 * 1024;

export interface Frame {
	op: number;
	data: unknown;
}

export function encodeFrame(op: number, payload: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(payload), 'utf8');
	const header = Buffer.alloc(8);
	header.writeUInt32LE(op, 0);
	header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

// Reassembles frames from a byte stream that may split or merge them.
export class FrameDecoder {
	#buffer = Buffer.alloc(0);

	push(chunk: Buffer): Frame[] {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		const frames: Frame[] = [];
		while (this.#buffer.length >= 8) {
			const op = this.#buffer.readUInt32LE(0);
			const length = this.#buffer.readUInt32LE(4);
			if (length > MAX_FRAME_BYTES) throw new Error(`frame of ${length} bytes exceeds limit`);
			if (this.#buffer.length < 8 + length) break;
			const body = this.#buffer.subarray(8, 8 + length).toString('utf8');
			this.#buffer = this.#buffer.subarray(8 + length);
			frames.push({ op, data: JSON.parse(body) });
		}
		return frames;
	}
}

export function ipcPaths(platform: NodeJS.Platform, runtimeDir: string): string[] {
	const ids = Array.from({ length: 10 }, (_, i) => i);
	if (platform === 'win32') return ids.map((i) => `\\\\?\\pipe\\discord-ipc-${i}`);
	const dirs = [runtimeDir];
	if (platform === 'linux') {
		dirs.push(path.join(runtimeDir, 'snap.discord'), path.join(runtimeDir, 'app', 'com.discordapp.Discord'));
	}
	return dirs.flatMap((dir) => ids.map((i) => path.join(dir, `discord-ipc-${i}`)));
}

export class DiscordIpc {
	#clientId: string;
	#onClose: (reason: string) => void;
	#socket: net.Socket | undefined;
	#closed = false;

	// onClose fires only for a connection that was established and then lost,
	// not after close().
	constructor(clientId: string, onClose: (reason: string) => void) {
		this.#clientId = clientId;
		this.#onClose = onClose;
	}

	async connect(paths: readonly string[], timeoutMs = 10_000): Promise<void> {
		const socket = await openFirst(paths);
		if (!socket) throw new Error('Discord is not running');
		const decoder = new FrameDecoder();

		await new Promise<void>((resolve, reject) => {
			let ready = false;
			let ended = false;
			const end = (reason: string) => {
				if (ended) return;
				ended = true;
				clearTimeout(timer);
				socket.destroy();
				this.#socket = undefined;
				if (!ready) reject(new Error(reason));
				else if (!this.#closed) this.#onClose(reason);
			};
			const timer = setTimeout(() => end('timed out waiting for Discord'), timeoutMs);

			socket.on('data', (chunk: Buffer) => {
				let frames: Frame[];
				try {
					frames = decoder.push(chunk);
				} catch (error) {
					end(`protocol error: ${(error as Error).message}`);
					return;
				}
				for (const { op, data } of frames) {
					if (op === Op.Ping) {
						socket.write(encodeFrame(Op.Pong, data));
					} else if (op === Op.Close) {
						end(closeReason(data));
						return;
					} else if (op === Op.Frame && !ready && isReady(data)) {
						ready = true;
						clearTimeout(timer);
						this.#socket = socket;
						resolve();
					}
				}
			});
			socket.on('error', (error) => end(error.message));
			socket.on('close', () => end('connection closed'));
			socket.write(encodeFrame(Op.Handshake, { v: 1, client_id: this.#clientId }));
		});
	}

	// null clears the presence.
	setActivity(activity: Activity | null): void {
		this.#socket?.write(
			encodeFrame(Op.Frame, {
				cmd: 'SET_ACTIVITY',
				args: { pid: process.pid, activity },
				nonce: randomUUID(),
			}),
		);
	}

	close(): void {
		this.#closed = true;
		this.#socket?.destroy();
		this.#socket = undefined;
	}
}

async function openFirst(paths: readonly string[]): Promise<net.Socket | undefined> {
	for (const candidate of paths) {
		const target = await resolveTrustedSocket(candidate);
		if (!target) continue;
		const socket = await new Promise<net.Socket | undefined>((resolve) => {
			const attempt = net.createConnection(target);
			attempt.once('connect', () => resolve(attempt));
			attempt.once('error', () => {
				attempt.destroy();
				resolve(undefined);
			});
		});
		if (socket) return socket;
	}
	return undefined;
}

// On Unix, resolves the candidate to its real path and accepts it only if the
// final entry is a socket owned by this user and every directory up to / is
// safe. The caller connects to that real path, so no other user can redirect
// the connection after the check (e.g. a planted /tmp/discord-ipc-0 or
// /tmp/snap.discord on a shared machine).
export async function resolveTrustedSocket(candidate: string): Promise<string | undefined> {
	if (process.platform === 'win32') return candidate;
	const uid = process.getuid?.();
	if (uid === undefined) return undefined;
	try {
		const real = await realpath(candidate);
		const entry = await lstat(real);
		if (!entry.isSocket() || entry.uid !== uid) return undefined;
		for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
			if (!isSafeDirectory(await lstat(dir), uid)) return undefined;
			if (dir === path.dirname(dir)) return real;
		}
	} catch {
		return undefined;
	}
}

// Owned by root or this user, and not writable by others unless sticky (like
// /tmp, where others cannot remove or rename entries they do not own).
export function isSafeDirectory(stats: Pick<Stats, 'uid' | 'mode' | 'isDirectory'>, uid: number): boolean {
	if (!stats.isDirectory()) return false;
	if (stats.uid !== 0 && stats.uid !== uid) return false;
	const writableByOthers = (stats.mode & 0o022) !== 0;
	const sticky = (stats.mode & 0o1000) !== 0;
	return !writableByOthers || sticky;
}

function isReady(data: unknown): boolean {
	return typeof data === 'object' && data !== null && 'evt' in data && data.evt === 'READY';
}

function closeReason(data: unknown): string {
	if (typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string') {
		return `closed by Discord: ${data.message.slice(0, 200)}`;
	}
	return 'closed by Discord';
}
