/**
 * Drop a leading section title the extractor duplicated into the chunk body. The heading is stored in
 * `section` AND repeated as the body's opening words; extraction fuses the heading and the answer into one
 * sentence with no terminator, so the PREFIX is removed rather than the sentence - dropping the sentence
 * would take the answer with it.
 *
 * Display-only: the raw chunk text stays the retrieval and anchor unit.
 *
 * @param text The cleaned chunk text.
 * @param section The chunk's section heading, when it has one.
 * @returns The text with a duplicated leading heading removed, otherwise the text unchanged.
 */
export function stripHeadingEcho(text: string, section?: string): string {
	if (!section || !text.startsWith(section)) return text;
	// `startsWith` compares characters, not words, so a section that is a prefix of a longer opening word
	// ("Education" against a body opening "Educational benefits") would cut mid-word.
	if (/[A-Za-z0-9]/.test(text.charAt(section.length))) return text;
	return text.slice(section.length).replace(/^[\s:.-]+/, '');
}
