// The only contacts this app is permitted to give that are NOT in the retrieved sources. They exist in
// exactly two situations the synthesis prompt authorizes: a crisis turn, and a question the sources do
// not cover. Everything else must be cited.
//
// They live here, once, because they had drifted into four places - the system prompt, CrisisCard, the
// resources list, and now a gate. A number that is wrong in one copy and right in the others is the worst
// possible failure for this particular audience.
//
// VERIFIED against the official sources on 2026-09-04:
//   veteranscrisisline.net       -> "Dial 988 then Press 1", text "838255", chat /get-help-now/chat/
//   va.gov/resources/helpful-va-phone-numbers -> 1-800-827-1000 is the VA benefits hotline; the Veterans
//   Crisis Line is listed as "988, select 1"
// Re-verify before changing any value here.

/** Veterans/Military Crisis Line. 24/7, free, confidential. */
export const CRISIS_LINE = {
	dial: '988',
	press: '1',
	text: '838255',
	chatUrl: 'https://www.veteranscrisisline.net/get-help-now/chat/',
	site: 'veteranscrisisline.net'
} as const;

/** The official contacts allowed when the retrieved sources do not cover a question. */
export const OFFICIAL_FALLBACK = {
	phone: '1-800-827-1000',
	site: 'va.gov'
} as const;

// A model turn is treated as a crisis response when it reaches for the crisis line. These constants do
// not appear in benefits prose, so the signal is high-precision - and it is only ever used to CLASSIFY.
// The model's own wording is never rendered on a crisis turn; the shipped CrisisCard is, because a person
// in crisis should see the same verified surface whether the keyword net or the model caught it.
const CRISIS_SIGNALS = [CRISIS_LINE.text, CRISIS_LINE.site.toLowerCase(), 'crisis line'];

/**
 * Whether a model answer is reaching for the crisis line rather than answering from sources.
 *
 * Args:
 *     text: The model's answer prose.
 *
 * Returns:
 *     True when the answer names the crisis line, by number, site, or name.
 */
export function mentionsCrisisLine(text: string): boolean {
	const t = text.toLowerCase();
	// "988" is matched on a digit boundary so a year or dollar figure containing 988 cannot trip it.
	if (/(?<!\d)988(?!\d)/.test(t)) return true;
	return CRISIS_SIGNALS.some((s) => t.includes(s));
}

/**
 * Whether a model answer is the authorized "the sources do not cover this" response.
 *
 * Args:
 *     text: The model's answer prose.
 *
 * Returns:
 *     True when the answer points at an official fallback contact.
 */
export function mentionsOfficialFallback(text: string): boolean {
	const t = text.toLowerCase();
	return t.includes(OFFICIAL_FALLBACK.phone) || t.includes(OFFICIAL_FALLBACK.site);
}
