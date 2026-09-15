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
const QUIZ_RUN_RE = /[^.!?]*\bQUIZ\s+TRUE\s+FALSE\b[\s\S]*$/i;

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
