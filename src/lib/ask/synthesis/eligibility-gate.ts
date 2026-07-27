// The 38-CFR pre-gate: a query that states the user's OWN facts and asks about their entitlement is
// routed to an impersonal, cited, general-info answer plus an accredited-VSO / va.gov redirect -- the
// model never adjudicates the user's personal facts. Intentionally errs toward short-circuiting: a false
// positive still yields a correct impersonal answer, while a false negative risks an unlawful
// personalized eligibility claim.
const FIRST_OR_SECOND_PERSON = /\b(i|i'm|im|i've|ive|my|me|you|your|we|our)\b/i;
// Matches an eligibility signal: a keyword, a personalized possessive (my rating / pay / BAH ...), the
// strong standalone "am i" / "what do i" frames, or an acquisition frame -- "(do|can|will|would) I" joined
// to an acquisition verb within the same clause, so "will I still receive" is caught while "when do I
// attend" (no acquisition verb) is not.
const ELIGIBILITY =
	/\b(qualif|eligib|entitl|am i|what do i|my (rating|claim|pay|bah|pension)|(do|can|will|would) i\b[^?.!]{0,30}\b(get|receive|qualif|claim|file))/i;

export interface EligibilityIntent {
	shortCircuit: boolean;
}

/**
 * Detect a personalized-eligibility query that must bypass free synthesis.
 *
 * @param query The user's raw question.
 * @returns shortCircuit=true when the query pairs personal framing with an eligibility ask.
 */
export function detectEligibilityIntent(query: string): EligibilityIntent {
	const hasPerson = FIRST_OR_SECOND_PERSON.test(query);
	const hasEligibility = ELIGIBILITY.test(query);
	return { shortCircuit: hasPerson && hasEligibility };
}
