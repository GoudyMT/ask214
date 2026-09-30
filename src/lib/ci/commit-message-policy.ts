const TYPES = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'security', 'perf'];

// One prefix, an optional lowercase scope, a colon, exactly one space, then a character that is not a space.
const SUBJECT_LINE = new RegExp(`^(?:${TYPES.join('|')})(?:\\([a-z0-9-]+\\))?: \\S`);

// The line git writes above the diff it appends for `git commit -v`; it and everything after it is not the message.
const SCISSORS = '# ------------------------ >8 ------------------------';

/**
 * Check a commit message against the project's one-line format.
 *
 * The message is one line, `type: subject` or `type(scope): subject`, with nothing after it: no body, no
 * footer, no trailer and no tool attribution. A second non-empty line is the one thing all of those share, so
 * the rule is stated once, about lines, rather than as a list of trailer names that a new one would slip past.
 *
 * Git hands the hook the message file as the editor left it, before git strips its own help text. So the
 * `#` lines and the scissors section are dropped here too, or a message written in an editor would fail on
 * the help git was about to remove.
 *
 * @param raw The text of the commit message file.
 * @returns A fixed sentence for each rule the message breaks, never quoting the message; empty when it is fine.
 */
export function findCommitMessageViolations(raw: string): string[] {
	const lines = raw.split(/\r?\n/);
	const cut = lines.findIndex((line) => line.trimEnd() === SCISSORS);
	const message = (cut === -1 ? lines : lines.slice(0, cut))
		.filter((line) => !line.startsWith('#'))
		.map((line) => line.trimEnd())
		.filter((line) => line !== '');

	const first = message[0];
	if (first === undefined) return ['The message is empty.'];

	const violations: string[] = [];
	if (message.length > 1) {
		violations.push('The message must be one line, with no body and no trailer.');
	}
	if (!SUBJECT_LINE.test(first)) {
		violations.push(
			`The line must be "type: subject" or "type(scope): subject", with a type of ${TYPES.join(', ')}.`
		);
		return violations;
	}

	const subject = first.slice(first.indexOf(': ') + 2);
	if (/^[A-Z]/.test(subject)) {
		violations.push('The subject must start with a lowercase letter.');
	}
	if (subject.endsWith('.')) {
		violations.push('The subject must not end with a period.');
	}
	return violations;
}
