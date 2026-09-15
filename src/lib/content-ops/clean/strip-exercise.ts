// A graded exercise does not always occupy a block of its own. One block in this corpus opens with real
// guidance on job offers and only turns into a true/false question bank at the end, so classify-block.ts
// deliberately keeps it (its exercise marker trails rather than opens) and the run is cut here instead.
//
// The cut runs from the quiz HEADING to the end of the block, not from the "mark each as true or false"
// instruction - because in this guide that instruction is printed AFTER the statements it governs. Cutting
// from the instruction would leave every false claim standing and remove only the words that explain them.
//
// The heading is identified by the TRUE/FALSE response grid the extractor leaves immediately behind it,
// which is what makes this a question bank rather than a section that happens to be titled "quiz". The
// leading `[^.!?]*` walks back to the end of the previous sentence, so the surviving prose keeps its own
// final terminator and nothing before the exercise is touched.
// Walking back from the heading stops at the nearest STRUCTURAL boundary, not merely at the nearest
// sentence terminator. Extraction flattens a page to one line, so a checklist sitting between the last
// full stop and the quiz heading has no terminator in it at all - an unbounded walk back swallows the
// whole list along with the exercise. The stop set is therefore sentence punctuation PLUS the list-marker
// glyphs this corpus uses, so a cut can lose at most the run adjacent to the heading rather than every
// item above it.
//
// That residual is real and deliberate: normalisation leaves no separator between the last list item and
// the heading that follows it, so no text-only rule can tell "Relocation assistance" from the start of
// "JOB OFFER and SALARY NEGOTIATION QUIZ". Bounding the damage is what is available without layout data.
// Glyphs are built from code points so this file stays pure ASCII.
const BOUNDARY_CODE_POINTS = [
	0x2022, 0x25a0, 0x25a1, 0x2666, 0x25cb, 0x25aa, 0x25cf, 0x2219, 0x00bb, 0x2212
];
const QUIZ_RUN_RE = new RegExp(
	'[^.!?' +
		BOUNDARY_CODE_POINTS.map((p) => String.fromCharCode(p)).join('') +
		String.fromCharCode(0x2776) +
		'-' +
		String.fromCharCode(0x277f) +
		']*\\bQUIZ\\s+TRUE\\s+FALSE\\b[\\s\\S]*$',
	'i'
);

/**
 * Cuts a trailing graded-exercise run off a block that is otherwise real content.
 *
 * The surviving text is left byte-verbatim - a prefix of the input, never rewritten or re-spaced -
 * because the clean stage asserts that every surviving block is still an in-order substring of the
 * re-derived normalizedText, which is the contract the chunk stage's offset mapping depends on.
 *
 * Args:
 *     text: One block's text, after any running affix has been stripped.
 *
 * Returns:
 *     The text with a trailing exercise run removed, or the text unchanged when it holds none.
 */
export function stripExercise(text: string): string {
	return text.replace(QUIZ_RUN_RE, '').trim();
}
