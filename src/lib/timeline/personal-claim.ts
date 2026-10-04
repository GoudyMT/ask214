/**
 * The wording guard for 38 CFR 14.629: the app states public facts and points to official help; it never tells a
 * person what they qualify for, are entitled to, will get, or have left to act. Tests run it over every line the
 * app shows about a task: the task data and the words the components add around it. No app code imports it.
 */
const PERSONAL =
	/\byou(?:'re| are| may| might| could| will| would)?(?: be)? (?:qualif\w*|eligible|entitled)\b|\byou(?:'ll| will| can)? (?:get|receive)\b|\byou (?:still )?have (?:until\b|(?:up to )?(?:\d+|a|an|one|two|three|six|twelve) (?:more )?(?:day|week|month|year)s?\b)|\bguarantee/i;

/** A curly apostrophe reads the same as a straight one, so it is folded before matching. */
const RIGHT_SINGLE_QUOTE = String.fromCharCode(0x2019);

/** Whether a line tells a person what they personally qualify for, will get, or have left. */
export function makesPersonalClaim(line: string): boolean {
	return PERSONAL.test(line.replaceAll(RIGHT_SINGLE_QUOTE, "'"));
}

/**
 * Every text node under an element, joined by spaces. Neither textContent nor innerText keeps words in separate
 * elements apart (a status and the date beside it, separated on screen only by CSS, read as one word), and the
 * guard matches whole words.
 */
export function textOf(root: Node): string {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const parts: string[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode())
		parts.push(node.textContent ?? '');
	return parts.join(' ');
}
