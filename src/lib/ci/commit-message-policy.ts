const TYPES = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'security', 'perf'];

// One prefix, an optional lowercase scope, a colon, exactly one space, then a character that is not a space.
const SUBJECT_LINE = new RegExp(`^(?:${TYPES.join('|')})(?:\\([a-z0-9-]+\\))?: \\S`);

// The line git writes above the diff it appends for `git commit -v`; when git cleans the message up, it and
// everything after it is not the message.
const SCISSORS = '# ------------------------ >8 ------------------------';

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/**
 * Check a commit message against the project's one-line format.
 *
 * The message is one line, `type: subject` or `type(scope): subject`, with nothing after it: no body, no
 * footer, no trailer and no tool attribution. A second non-empty line is the one thing all of those share, so
 * the rule is stated once, about lines, rather than as a list of trailer names that a new one would slip past.
 *
 * Line breaks are `\n`, or `\r\n`. Any other control character, a tab or a carriage return on its own
 * included, is refused: a lone carriage return ends a line to some readers and not to others, so a second line
 * could hide behind it. A byte-order mark at the start is refused with its own sentence; some shells put one
 * there when they pipe text, and it would otherwise show up as a message that looks right but is not.
 *
 * Whether `#` lines are text depends on who reads the message. A message already recorded is exactly what
 * git kept, so a `#` line is part of it and counts as a message line. The commit-msg hook instead sees the
 * text before git cleans it, and cannot tell which cleanup git will run; it asks for `stripComments`, which
 * drops every `#` line and everything from the scissors line on, as git's editor cleanup does, so the hook
 * never refuses a message that git would record correctly.
 *
 * @param raw The text of the commit message.
 * @param options `stripComments`: true only for the text of the file the hook reads. Default false, the
 *   strict reading of a recorded message.
 * @returns A fixed sentence for each rule the message breaks, never quoting the message; empty when it is fine.
 */
export function findCommitMessageViolations(
	raw: string,
	options: { stripComments?: boolean } = {}
): string[] {
	const violations: string[] = [];
	const hasMark = raw.startsWith(BYTE_ORDER_MARK);
	if (hasMark)
		violations.push('The message starts with a byte-order mark; save it as UTF-8 without one.');

	const lines = (hasMark ? raw.slice(1) : raw)
		.split('\n')
		.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
	const cut = lines.findIndex((line) => line.trimEnd() === SCISSORS);
	const written =
		options.stripComments === true
			? (cut === -1 ? lines : lines.slice(0, cut)).filter((line) => !line.startsWith('#'))
			: lines;
	// Only trailing spaces and tabs are let go here: a blank line may end in either, but a carriage return or
	// any other control character left on a line is content.
	const content = written.map((line) => line.replace(/[ \t]+$/, '')).filter((line) => line !== '');

	const first = content[0];
	if (first === undefined) return [...violations, 'The message is empty.'];

	if (content.length > 1) {
		violations.push('The message must be one line, with no body and no trailer.');
	}
	if (content.some((line) => /\p{Cc}/u.test(line))) {
		violations.push(
			'The message holds a control character, such as a tab or a lone carriage return; use plain text.'
		);
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
