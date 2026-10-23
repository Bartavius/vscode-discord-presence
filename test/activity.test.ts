import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildActivity, CLAUDE_VERBS, claudeVerb, type PresenceInput, VERB_MS } from '../src/activity.ts';

const base: PresenceInput = { languageId: 'typescript', debugging: false, claude: false, showLanguage: true, startedAt: 1_700_000_000_000, now: 0 };

test('sends exactly the allowed fields', () => {
	assert.deepEqual(buildActivity(base), {
		details: 'Editing a typescript file',
		timestamps: { start: 1_700_000_000_000 },
		assets: { large_image: 'vscode', large_text: 'Visual Studio Code' },
		instance: false,
	});
});

test('idles when no editor is active', () => {
	assert.equal(buildActivity({ ...base, languageId: undefined }).details, 'Idling');
});

test('reports debugging', () => {
	assert.equal(buildActivity({ ...base, debugging: true }).details, 'Debugging a typescript file');
});

test('hides the language when showLanguage is off', () => {
	assert.equal(buildActivity({ ...base, showLanguage: false }).details, 'Coding');
	assert.equal(buildActivity({ ...base, showLanguage: false, debugging: true }).details, 'Debugging');
});

test('does not forward language IDs that do not look like language IDs', () => {
	for (const languageId of ['', '/Users/me/secret.ts', 'has spaces', 'a'.repeat(65), 'https://example.com']) {
		assert.equal(buildActivity({ ...base, languageId }).details, 'Coding', languageId);
	}
});

test('reports Claude, unless debugging', () => {
	assert.equal(buildActivity({ ...base, claude: true }).details, 'Pondering with Claude-kun');
	assert.equal(buildActivity({ ...base, claude: true, languageId: undefined }).details, 'Pondering with Claude-kun');
	assert.equal(buildActivity({ ...base, claude: true, showLanguage: false }).details, 'Pondering with Claude-kun');
	assert.equal(buildActivity({ ...base, claude: true, debugging: true }).details, 'Debugging a typescript file');
});

test('rotates the Claude verb every VERB_MS and wraps around', () => {
	assert.equal(claudeVerb(VERB_MS - 1), CLAUDE_VERBS[0]);
	assert.equal(claudeVerb(VERB_MS), CLAUDE_VERBS[1]);
	assert.equal(claudeVerb(VERB_MS * CLAUDE_VERBS.length), CLAUDE_VERBS[0]);
	assert.equal(new Set(CLAUDE_VERBS).size, CLAUDE_VERBS.length);
});
