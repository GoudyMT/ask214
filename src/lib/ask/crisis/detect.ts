// First-line crisis detector: a cheap keyword net for OBVIOUS self-harm, suicidal, or
// danger-to-others language, checked BEFORE any retrieval or synthesis so a person in crisis is routed
// to help instead of benefits results. Tuned to err toward firing - a false positive shows the crisis
// line (a safe outcome); a miss is the failure that matters. It is deliberately NOT comprehensive:
// indirect or coded expressions will slip, and the synthesis system prompt's safety clause is the
// backstop for those. On the on-device path a miss shows normal results, never a wrong answer.
const CRISIS_PATTERNS: RegExp[] = [
	/\b(suicidal|suicide)\b/i,
	/\b(kill|hurt|harm)(ing)?\s+(myself|my\s?self)\b/i,
	/\bkill(ing)?\s+(him|her|them|someone|somebody)\b/i,
	/\b(want|wanna|going|plan(ning)?)\s+to\s+die\b/i,
	/\b(don'?t|do\s+not|no\s+longer)\s+want\s+to\s+(live|be\s+(here|alive))\b/i,
	/\bend(ing)?\s+(my\s+life|it\s+all)\b/i,
	/\b(take|taking|ending)\s+my\s+own\s+life\b/i,
	/\b(better\s+off|rather\s+be)\s+dead\b/i,
	/\bno\s+(reason|point)\s+(to\s+|in\s+)?(live|living|go\s+on)\b/i,
	/\b(can'?t|cannot)\s+(go\s+on|keep\s+going)\b/i
];

export interface CrisisIntent {
	crisis: boolean;
}

/**
 * Detect an obvious crisis / self-harm message that must bypass retrieval and synthesis.
 *
 * @param query The user's raw question.
 * @returns crisis=true when the message matches clear self-harm, suicidal, or danger-to-others language.
 */
export function detectCrisisIntent(query: string): CrisisIntent {
	return { crisis: CRISIS_PATTERNS.some((pattern) => pattern.test(query)) };
}
