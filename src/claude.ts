// Recognises a terminal command line that starts Claude Code, such as
// "claude", "claude --resume" or "FOO=1 ~/.local/bin/claude". Only the yes/no
// answer is used; the command line itself never leaves the extension.
export function isClaudeCommand(commandLine: string): boolean {
	const words = commandLine.trim().split(/\s+/);
	const program = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
	if (program === undefined) return false;
	const name = program.replace(/^["']|["']$/g, '').split(/[\\/]/).pop();
	return name === 'claude' || name === 'claude.exe';
}
