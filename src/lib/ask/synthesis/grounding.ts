// A number, date, or threshold in a synthesized answer is the highest-risk claim a veteran may act on.
// Verify each numeric token appears verbatim in the cited chunk text; an ungrounded number downgrades the
// answer to a refusal ("the official sources don't state this precisely").
const NUM = /\d[\d,.:/-]*\d|\d/g;

export interface GroundingCheck {
	grounded: boolean;
	ungrounded: string[];
}

/**
 * Verify every numeric token in the answer appears in the cited text.
 *
 * @param answer The synthesized answer.
 * @param citedText The concatenated text of the cited chunks.
 * @returns grounded=true only when no numeric token is missing from the cited text.
 */
export function checkNumericGrounding(answer: string, citedText: string): GroundingCheck {
	const nums = answer.match(NUM) ?? [];
	const ungrounded = nums.filter((n) => !citedText.includes(n));
	return { grounded: ungrounded.length === 0, ungrounded };
}
