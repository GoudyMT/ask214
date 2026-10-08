/**
 * The wording guard for 38 CFR 14.629: the app states public facts and points to official help; it never tells a
 * person what they qualify for, are entitled to, will get, or have left to act. Tests run it over every line the
 * app shows about a task: the task data and the words the components add around it. No app code imports it.
 */
const PERSONAL =
	/\byou(?:'re| are| may| might| could| will| would)?(?: be)? (?:qualif\w*|eligible|entitled)\b|\byou(?:'ll| will| can)? (?:get|receive)\b|\byou (?:still )?have (?:until\b|(?:up to )?(?:\d+|a|an|one|two|three|six|twelve) (?:more )?(?:day|week|month|year)s?\b)|\bguarantee/i;

/**
 * An approval claim is an eligibility claim too: a line that says the reader is or will be approved, or that their
 * request or command will approve it, decides a case only the approving command can decide. A line that only names who
 * approves ("Find out who will approve your request.") or asks the reader to find out whether, if, once, when or until
 * their request is approved does not match. A line that names who approves and then says that person will approve the
 * request ("Ask your command who will approve your request.") still does, as a claim about this request.
 */
const APPROVAL =
	/\byou(?:'re|'ve been|'d|'ll| are| were| have been| will| would| can| may| might| could| should)(?: (?:\w+ly|now|already|also))?(?: be| get)? approved\b|(?<!\b(?:whether|if|once|when|until) )\byour (?:\w+ )?(?:request|command|package|application|co|oic)(?: \w+){0,2} (?:is|was|has been|will|would|should|may|might|could|can)(?: (?:\w+ly|now|already|also))?(?: be| get)? approv\w*|(?<!\bwho )\bwill approve your\b/i;

/** A curly apostrophe reads the same as a straight one, so it is folded before matching. */
const RIGHT_SINGLE_QUOTE = String.fromCharCode(0x2019);

/** Whether a line tells a person what they personally qualify for, will get, have left, or will be approved for. */
export function makesPersonalClaim(line: string): boolean {
	const folded = line.replaceAll(RIGHT_SINGLE_QUOTE, "'");
	return PERSONAL.test(folded) || APPROVAL.test(folded);
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
