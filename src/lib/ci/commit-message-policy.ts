const TYPES = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'security', 'perf'];

// One prefix, an optional lowercase scope, a colon, exactly one space, then a character that is not a space.
const SUBJECT_LINE = new RegExp(`^(?:${TYPES.join('|')})(?:\\([a-z0-9-]+\\))?: \\S`);

// The line git writes above the diff it appends for `git commit -v`; when an editor opened, it and everything
// after it is not the message.
const SCISSORS = '# ------------------------ >8 ------------------------';

/**
 * Check a commit message against the project's one-line format.
 *
 * The message is one line, `type: subject` or `type(scope): subject`, with nothing after it: no body, no
 * footer, no trailer and no tool attribution. A second non-empty line is the one thing all of those share, so
 * the rule is stated once, about lines, rather than as a list of trailer names that a new one would slip past.
 *
 * What git does with `#` lines depends on how the message was given. When it opens an editor, the file holds
 * git's own help text (`#` lines, and after a scissors line a diff) and git removes all of it after the hook
 * runs, so a message written there would fail on text that is about to disappear; those lines are dropped
 * here too. When no editor opens (`git commit -m` or `-F`), git removes nothing: a `#` line or anything below
 * a scissors line is recorded as part of the message, so each counts as a message line. When the caller does
 * not say, the message is treated as written with no editor, the stricter reading.
 *
 * @param raw The text of the commit message file.
 * @param options `editorOpened`: true only when git opened an editor to write the message.
 * @returns A fixed sentence for each rule the message breaks, never quoting the message; empty when it is fine.
 */
export function findCommitMessageViolations(
	raw: string,
	options: { editorOpened?: boolean } = {}
): string[] {
	const lines = raw.split(/\r?\n/);
	const cut = lines.findIndex((line) => line.trimEnd() === SCISSORS);
	const written =
		options.editorOpened === true
			? (cut === -1 ? lines : lines.slice(0, cut)).filter((line) => !line.startsWith('#'))
			: lines;
	const message = written.map((line) => line.trimEnd()).filter((line) => line !== '');

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
