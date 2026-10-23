import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isClaudeCommand } from '../src/claude.ts';

test('recognises commands that start Claude Code', () => {
	for (const commandLine of [
		'claude',
		'  claude --resume',
		'claude "fix the build"',
		'~/.local/bin/claude',
		'"/opt/claude code/claude" -c',
		'DEBUG=1 claude',
		'C:\\Users\\me\\claude.exe',
	]) {
		assert.equal(isClaudeCommand(commandLine), true, commandLine);
	}
});

test('ignores other commands', () => {
	for (const commandLine of ['', 'ls', 'echo claude', 'claude-dev', 'git commit -m claude', 'FOO=claude', 'claudette']) {
		assert.equal(isClaudeCommand(commandLine), false, commandLine);
	}
});
