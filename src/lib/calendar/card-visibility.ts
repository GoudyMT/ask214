/** Dismissal bookkeeping for the Timeline calendar card (persisted in the calendar-sync store). */
export type CardDismissal = {
	dismissedAt?: number; // epoch ms of the most recent dismissal
	dismissCount?: number; // how many times the user has dismissed the card
};

/** How long a dismissal silences the card before it may re-appear. */
export const CARD_COOLDOWN_MS = 72 * 60 * 60 * 1000; // 72 hours

/** After this many dismissals the card never returns - repeated dismissal is a clear answer. */
export const CARD_MAX_DISMISSALS = 3;

/**
 * Whether the Timeline's calendar card should render. Never dismissed -> show. Dismissed ->
 * stay silent until the cooldown elapses, so declining is respected for days instead of nagging
 * on the next app open. Dismissed CARD_MAX_DISMISSALS times -> never again; the user has
 * answered. Pure + deterministic; `now` is injected.
 */
export function shouldShowCalendarCard(d: CardDismissal, now: number): boolean {
	if ((d.dismissCount ?? 0) >= CARD_MAX_DISMISSALS) return false;
	if (d.dismissedAt === undefined) return true;
	return now - d.dismissedAt >= CARD_COOLDOWN_MS;
}
