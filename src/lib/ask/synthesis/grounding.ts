// A number, date, or threshold in a synthesized answer is the highest-risk claim a veteran may act on.
// Verify each numeric token in the answer appears as a STANDALONE number in the cited chunk text: a bare
// substring match is not enough (a fabricated "5%" must not count as grounded because "2025" contains a
// 5), and a figure the source spells out ("ten years") still grounds the digits the model writes ("10").
// An ungrounded number downgrades the answer to a refusal.
const NUM = /\d[\d,.:/-]*\d|\d/g;

// Standalone number words, normalized to digits so a spelled-out source figure grounds a digit answer and
// vice versa. Kept to single words; a compound like "ten thousand" normalizes to two separate tokens and
// may over-refuse -- the safe direction (a refusal, never a false grounding).
const WORD_TO_DIGIT: Record<string, string> = {
	zero: '0',
	one: '1',
	two: '2',
	three: '3',
	four: '4',
	five: '5',
	six: '6',
	seven: '7',
	eight: '8',
	nine: '9',
	ten: '10',
	eleven: '11',
	twelve: '12',
	thirteen: '13',
	fourteen: '14',
	fifteen: '15',
	sixteen: '16',
	seventeen: '17',
	eighteen: '18',
	nineteen: '19',
	twenty: '20',
	thirty: '30',
	forty: '40',
	fifty: '50',
	sixty: '60',
	seventy: '70',
	eighty: '80',
	ninety: '90',
	hundred: '100',
	thousand: '1000'
};
const NUMBER_WORD = new RegExp('\\b(' + Object.keys(WORD_TO_DIGIT).join('|') + ')\\b', 'gi');

export interface GroundingCheck {
	grounded: boolean;
	ungrounded: string[];
}

// Replace standalone number words with their digit form so both sides tokenize the same way.
function normalizeSpelled(text: string): string {
	return text.replace(NUMBER_WORD, (word) => WORD_TO_DIGIT[word.toLowerCase()] ?? word);
}

function numericTokens(text: string): string[] {
	return normalizeSpelled(text).match(NUM) ?? [];
}

/**
 * Verify every numeric token in the answer appears as a standalone number in the cited text.
 *
 * @param answer The synthesized answer.
 * @param citedText The concatenated text of the chunks the model cited.
 * @returns grounded=true only when every numeric token in the answer is present in the cited text.
 */
export function checkNumericGrounding(answer: string, citedText: string): GroundingCheck {
	const citedTokens = new Set(numericTokens(citedText));
	const ungrounded = numericTokens(answer).filter((n) => !citedTokens.has(n));
	return { grounded: ungrounded.length === 0, ungrounded };
}
