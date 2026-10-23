import * as os from 'node:os';
import * as vscode from 'vscode';
import { buildActivity } from './activity.ts';
import { isClaudeCommand } from './claude.ts';
import { DiscordIpc, ipcPaths } from './ipc.ts';

const RETRY_MS = 30_000;
const CLIENT_ID = /^\d{17,20}$/;

export function activate(context: vscode.ExtensionContext): void {
	const startedAt = Date.now();
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	status.command = 'discordPresence.toggle';

	let ipc: DiscordIpc | undefined;
	let retry: NodeJS.Timeout | undefined;
	// Bumped by stop() so callbacks from an older connection attempt are ignored.
	let generation = 0;
	// Terminals currently running Claude Code, detected through shell integration.
	const claudeRuns = new Map<vscode.Terminal, vscode.TerminalShellExecution>();

	const config = () => vscode.workspace.getConfiguration('discordPresence');

	const show = (text: string, tooltip: string) => {
		status.text = text;
		status.tooltip = tooltip;
		status.show();
	};

	const update = () => {
		ipc?.setActivity(
			buildActivity({
				languageId: vscode.window.activeTextEditor?.document.languageId,
				debugging: vscode.debug.activeDebugSession !== undefined,
				claude: vscode.window.activeTerminal !== undefined && claudeRuns.has(vscode.window.activeTerminal),
				showLanguage: config().get<boolean>('showLanguage', true),
				startedAt,
			}),
		);
	};

	const stop = () => {
		generation++;
		clearTimeout(retry);
		ipc?.close();
		ipc = undefined;
	};

	const scheduleRetry = () => {
		retry = setTimeout(() => void start(), RETRY_MS);
	};

	const start = async () => {
		stop();
		if (!config().get<boolean>('enabled', true)) {
			show('$(circle-slash) Discord', 'Discord Presence is off. Click to turn it on.');
			return;
		}
		const clientId = config().get<string>('clientId', '').trim();
		if (!CLIENT_ID.test(clientId)) {
			show('$(warning) Discord', 'Set "discordPresence.clientId" to your Discord application ID.');
			return;
		}

		const mine = generation;
		show('$(sync~spin) Discord', 'Connecting to Discord...');
		const client = new DiscordIpc(clientId, (reason) => {
			if (mine !== generation) return;
			ipc = undefined;
			show('$(debug-disconnect) Discord', `Disconnected (${reason}). Retrying every 30s.`);
			scheduleRetry();
		});

		try {
			await client.connect(ipcPaths(process.platform, process.env.XDG_RUNTIME_DIR || os.tmpdir()));
		} catch (error) {
			if (mine !== generation) return;
			show('$(debug-disconnect) Discord', `Not connected (${(error as Error).message}). Retrying every 30s.`);
			scheduleRetry();
			return;
		}
		if (mine !== generation) {
			client.close();
			return;
		}

		ipc = client;
		const shared = config().get<boolean>('showLanguage', true) ? 'activity and language' : 'activity only';
		show('$(pass) Discord', `Connected. Sharing ${shared}. Click to turn off.`);
		update();
	};

	context.subscriptions.push(
		status,
		{ dispose: stop },
		vscode.commands.registerCommand('discordPresence.toggle', async () => {
			const enabled = config().get<boolean>('enabled', true);
			await config().update('enabled', !enabled, vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('discordPresence.reconnect', () => start()),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (
				event.affectsConfiguration('discordPresence.enabled') ||
				event.affectsConfiguration('discordPresence.clientId')
			) {
				void start();
			} else if (event.affectsConfiguration('discordPresence.showLanguage')) {
				update();
			}
		}),
		vscode.window.onDidChangeActiveTextEditor(update),
		vscode.debug.onDidStartDebugSession(update),
		vscode.debug.onDidTerminateDebugSession(update),
		vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
			if (!isClaudeCommand(execution.commandLine.value)) return;
			claudeRuns.set(terminal, execution);
			update();
		}),
		vscode.window.onDidEndTerminalShellExecution(({ terminal, execution }) => {
			if (claudeRuns.get(terminal) !== execution) return;
			claudeRuns.delete(terminal);
			update();
		}),
		vscode.window.onDidCloseTerminal((terminal) => {
			if (claudeRuns.delete(terminal)) update();
		}),
		vscode.window.onDidChangeActiveTerminal(update),
		// With several windows open, the focused one sets the presence.
		vscode.window.onDidChangeWindowState((state) => {
			if (state.focused) update();
		}),
	);

	void start();
}

export function deactivate(): void {}
