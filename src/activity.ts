// The only editor state that can reach Discord. There is deliberately no field
// for file names, paths, workspace names, hosts or git data.
export interface PresenceInput {
	languageId: string | undefined;
	debugging: boolean;
	// True while Claude Code runs in the active terminal.
	claude: boolean;
	showLanguage: boolean;
	startedAt: number;
	// Picks the Claude verb, which changes every VERB_MS.
	now: number;
}

export interface Activity {
	details: string;
	timestamps: { start: number };
	assets: { large_image: string; large_text: string };
	instance: false;
}

export const LARGE_IMAGE_KEY = 'vscode';

// VS Code language IDs look like "typescript" or "objective-cpp". Anything else
// is replaced rather than forwarded.
const LANGUAGE_ID = /^[a-z0-9][a-z0-9._+-]{0,63}$/i;

// Rotated through while Claude runs, in the spirit of Claude Code's spinner.
export const CLAUDE_VERBS = [
	'pondering',
	'noodling',
	'clauding',
	'percolating',
	'scheming',
	'cogitating',
	'tinkering',
	'brewing',
	'mulling',
	'wrangling',
	'conjuring',
	'simmering',
	'puzzling',
	'finagling',
	'ruminating',
	'whirring',
] as const;

// Discord accepts about five activity updates per 20 seconds.
export const VERB_MS = 20_000;

export function buildActivity(input: PresenceInput): Activity {
	return {
		details: describe(input),
		timestamps: { start: input.startedAt },
		assets: { large_image: LARGE_IMAGE_KEY, large_text: 'Visual Studio Code' },
		instance: false,
	};
}

export function claudeVerb(now: number): string {
	return CLAUDE_VERBS[Math.floor(now / VERB_MS) % CLAUDE_VERBS.length] ?? 'thinking';
}

function describe({ languageId, debugging, claude, showLanguage, now }: PresenceInput): string {
	if (claude && !debugging) {
		const verb = claudeVerb(now);
		return `${verb[0]?.toUpperCase()}${verb.slice(1)} with Claude-kun`;
	}
	if (languageId === undefined) return 'Idling';
	if (!showLanguage || !LANGUAGE_ID.test(languageId)) return debugging ? 'Debugging' : 'Coding';
	return `${debugging ? 'Debugging' : 'Editing'} a ${languageId} file`;
}
