/**
 * A heading that OPENS with a conditional subordinator is the antecedent of the sentence after it, not a
 * label on the passage: "If you served in certain locations..." governs "You're eligible for VA health
 * care." Removing it leaves an unconditional determination the source never made.
 *
 * Keyed on the opener rather than on the word appearing anywhere, because a heading that merely mentions a
 * condition later ("What to do if you move") still labels its passage instead of governing it.
 */
const GOVERNING_CONDITION_RE = /^(?:if|unless)\b/i;

/**
 * Drop a leading section title the extractor duplicated into the chunk body. The heading is stored in
 * `section` AND repeated as the body's opening words; extraction fuses the heading and the answer into one
 * sentence with no terminator, so the PREFIX is removed rather than the sentence - dropping the sentence
 * would take the answer with it.
 *
 * A heading that GOVERNS the body rather than labelling it is kept, so the passage cannot read as an
 * unconditional determination.
 *
 * Display-only: the raw chunk text stays the retrieval and anchor unit.
 *
 * @param text The cleaned chunk text.
 * @param section The chunk's section heading, when it has one.
 * @returns The text with a duplicated leading heading removed, otherwise the text unchanged.
 */
export function stripHeadingEcho(text: string, section?: string): string {
	if (!section || !text.startsWith(section)) return text;
	// Keeping the echo is the lesser harm: a repeated clause reads as clumsy, a missing one reads as false.
	if (GOVERNING_CONDITION_RE.test(section)) return text;
	// `startsWith` compares characters, not words, so a section that is a prefix of a longer opening word
	// ("Education" against a body opening "Educational benefits") would cut mid-word.
	if (/[A-Za-z0-9]/.test(text.charAt(section.length))) return text;
	return text.slice(section.length).replace(/^[\s:.-]+/, '');
}
