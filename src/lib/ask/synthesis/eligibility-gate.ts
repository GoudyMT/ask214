// The 38-CFR pre-gate: a query that states the user's OWN facts and asks about their entitlement is
// routed to an impersonal, cited, general-info answer plus an accredited-VSO / va.gov redirect -- the
// model never adjudicates the user's personal facts. Intentionally errs toward short-circuiting: a false
// positive still yields a correct impersonal answer, while a false negative risks an unlawful
// personalized eligibility claim.
//
// Shape, not keywords: short-circuit needs BOTH a personal-fact marker AND an entitlement-seeking ask.
// The entitlement signal is a union of intent forms, not a single phrase list, so paraphrases are caught
// ("do I keep", "still rate", "what I can draw", "bar me from", "cost me", "what's mine") rather than only
// the literal wordings. It deliberately EXCLUDES procedural verbs (have / use / read / transfer), so a
// personal question about the LOGISTICS of a benefit ("how long do I have to use the GI Bill") is answered,
// not redirected -- the synthesis prompt's own 38-CFR clause is the second layer for that gray zone.

// Personal-fact markers, incl. the possessive "mine" (an ownership claim over a benefit).
const FIRST_OR_SECOND_PERSON = /\b(i|i'm|im|i've|ive|my|me|mine|you|your|we|our)\b/i;

// This is a FIRST-LAYER filter over natural language, so it cannot be exhaustive; the synthesis system
// prompt's own 38-CFR clause is the second layer for residual paraphrases, and a family of procedural
// over-redirects (a how-to / status / timing question that trips a bare possessive-benefit like "my pay"
// or "my claim") are accepted err-safe residuals - narrowing to remove them would risk a false negative,
// the direction that carries the legal risk.
//
// Entitlement / adjudication asks (any one is enough), paired above with a personal marker:
const ELIGIBILITY_SIGNALS: RegExp[] = [
	// Eligibility keyword stems + an optional negating prefix, so denial-of-eligibility words match too
	// (dis-qualify, in-eligible, un-entitled) - a personal "does my OTH disqualify me" is the highest-risk
	// adjudication. No trailing boundary so the stems match their inflections (qualif-y, eligib-le).
	/\b(?:dis|in|un|re)?(qualif|eligib|entitl)/i,
	// The strong standalone "am i" / "what do i" frames.
	/\b(am i|what do i)\b/i,
	// A possessive benefit: "my [<=2 adjectives] rating / pay / ... / account". No trailing boundary (like
	// signal 1) so inflections match - "my paycheck", "my payout", "my benefits". NOT verb-guarded, so some
	// procedural "my <noun>" how-tos ("direct deposit for my pay") over-redirect - an accepted err-safe
	// residual (a false positive still yields a correct impersonal answer; narrowing would risk the
	// false-negative direction that carries the legal risk).
	/\bmy(?:\s+\S+){0,2}\s+(rating|claim|pay|bah|pension|payment|check|compensation|benefit|amount|account)s?/i,
	// Modal-first acquisition: "(do|can|could|will|would|may|might|won't|...) I ... <acquire>" in one clause.
	/\b(do|can|could|will|would|may|might|won'?t|can'?t|wouldn'?t|couldn'?t|don'?t|didn'?t)\s+i\b[^?.!]{0,30}\b(get|receive|keep|draw|rate|collect|qualif|claim|file|lose)\b/i,
	// Subject-first acquisition: "I can / could / will / still ... <acquire>" (e.g. "what I can draw").
	/\b(i|we)\s+(can|could|would|will|still)\b[^?.!]{0,20}\b(get|receive|keep|draw|rate|collect|qualif|claim|file|lose)\b/i,
	// Entitlement idioms that read as eligibility in almost any context: "bar/block/owe/cover me".
	/\b(bar|block|owe|cover)s?\s+(me|us)\b/i,
	// "cost/leave me" ONLY in the forfeit/allocation sense (a following possessive/benefit, or for|with|without),
	// so the price sense ("what will it cost me?") and the schedule sense ("leave me enough time") stay allowed.
	/\bcosts?\s+(me|us)\s+(my|the|our|a)\b/i,
	/\bleaves?\s+(me|us)\s+(for|with|without|out\s+of)\b/i,
	// "put in for", "count toward", and a possessive-claim "mine" (guarded so the mineral noun + "till mine" miss).
	/\bput\s+in\s+for\b/i,
	/\bcounts?\s+toward\b/i,
	/\b(is|it'?s|that'?s|what'?s|still|now|even|really|not|all|and)\s+mine\b/i
];

export interface EligibilityIntent {
	shortCircuit: boolean;
}

/**
 * Detect a personalized-eligibility query that must bypass free synthesis.
 *
 * @param query The user's raw question.
 * @returns shortCircuit=true when the query pairs personal framing with an entitlement ask.
 */
export function detectEligibilityIntent(query: string): EligibilityIntent {
	const hasPerson = FIRST_OR_SECOND_PERSON.test(query);
	const hasEligibility = ELIGIBILITY_SIGNALS.some((re) => re.test(query));
	return { shortCircuit: hasPerson && hasEligibility };
}
