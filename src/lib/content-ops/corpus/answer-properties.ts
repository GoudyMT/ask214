/**
 * Properties every RENDERED answer must hold, checked over the whole corpus rather than the benchmarked
 * few hundred chunks.
 *
 * These exist because the alternative does not scale. A rule that names one bad string ("drop this quiz
 * table") only protects against sources already seen; a new guide brings a new shape and the same class of
 * defect ships again. A property describes the SHAPE that makes an answer unsafe to read alone, so a source
 * nobody has ingested yet is gated by it too.
 *
 * Each property here measured ZERO violations over the shipped corpus when it was written. That is the
 * entry requirement: a property that already fires is a finding to act on, not an invariant to enforce, and
 * adding it would only teach the next reader to ignore the gate. Anything added is enumerated over every
 * chunk and every match read first - a speculative list once scored 238 dirty chunks that were
 * overwhelmingly legitimate phone numbers, pipes and headings.
 */

/** The fields of a chunk a property may consult. The answer itself is passed separately. */
export type PropertyChunk = { section?: string };

export type AnswerProperty = {
	/** Stable kebab-case id, reported when the property fails. */
	id: string;
	/** What must be true, phrased as the requirement rather than the violation. */
	describe: string;
	violates(answer: string, chunk: PropertyChunk): boolean;
};

/**
 * A heading that opens with a conditional subordinator governs the sentence after it. When the answer does
 * not carry that opener, the passage has been cut loose from the clause that scopes it and reads as an
 * unconditional determination the source never made.
 */
const CONDITIONAL_OPENER = /^(?:if|unless)\b/i;

/** Page furniture matched whole and exact; the shortest chunks are overwhelmingly real content. */
const CHROME = new Set([
	'was this page helpful?',
	'related articles',
	'related information',
	'related benefits & services',
	'browse by topic'
]);

export const ANSWER_PROPERTIES: AnswerProperty[] = [
	{
		id: 'condition-attached',
		describe: 'an answer keeps the governing condition its section states',
		violates: (answer, chunk) =>
			chunk.section !== undefined &&
			CONDITIONAL_OPENER.test(chunk.section.trim()) &&
			!CONDITIONAL_OPENER.test(answer.trim())
	},
	{
		id: 'no-graded-exercise',
		// A statement bank is worse than multiple choice: multiple choice at least signals optionality,
		// while a bank of ungraded claims reads as the document's own declarative prose. The appendix that
		// RESOLVES each claim is real guidance and must not match - it states the claim and then answers it.
		describe: 'an answer carries no graded-exercise question bank or answer-key table',
		violates: (answer) =>
			/\bQUIZ\s+TRUE\s+FALSE\b/i.test(answer) ||
			/Module Question\s+(?:Module\s+\d|Number\s+Answer)/i.test(answer) ||
			/(?:TRUE\s+FALSE\s+){3,}/i.test(answer)
	},
	{
		id: 'no-page-chrome',
		describe: 'an answer is document content, not page navigation furniture',
		violates: (answer) => CHROME.has(answer.trim().toLowerCase())
	},
	{
		id: 'no-answer-key-row',
		// The page-and-module citation must be ADJACENT to match: prose routinely mentions a module and a
		// page in the same sentence, and only the key's table rows put them side by side.
		describe: 'an answer is not a row lifted from an answer key',
		violates: (answer) => /\b(?:Page|PG)\s+\d+\s+Module\s+\d/i.test(answer)
	}
];

/**
 * Which properties this answer breaks.
 *
 * @param answer The rendered answer text, exactly as a reader would see it.
 * @param chunk The chunk it was cut from.
 * @returns The ids of every violated property; empty means the answer is clean.
 */
export function violatedProperties(answer: string, chunk: PropertyChunk): string[] {
	return ANSWER_PROPERTIES.filter((p) => p.violates(answer, chunk)).map((p) => p.id);
}
