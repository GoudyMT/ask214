/**
 * Whole-day arithmetic on the engine's ISO dates (YYYY-MM-DD). Every date is read as a UTC calendar day - the
 * same anchoring as eaosOffsetDate - so neither the runtime timezone nor the time of day can shift a count.
 */

const MS_PER_DAY = 86_400_000;

function dayNumber(iso: string): number {
	const [y, m, d] = iso.split('-').map(Number);
	return Date.UTC(y!, m! - 1, d!) / MS_PER_DAY;
}

/** Whole days from one ISO date to another; positive when `toIso` is later. */
export function daysBetween(fromIso: string, toIso: string): number {
	return dayNumber(toIso) - dayNumber(fromIso);
}

/** The ISO date `days` after `iso` (before it when negative). */
export function addDays(iso: string, days: number): string {
	return new Date((dayNumber(iso) + days) * MS_PER_DAY).toISOString().slice(0, 10);
}
