/**
 * Whole-day arithmetic on the engine's ISO dates (YYYY-MM-DD). The dates are calendar days with no time zone; the
 * arithmetic runs on UTC day numbers - the same anchoring as eaosOffsetDate - so neither the runtime time zone nor
 * the time of day can shift a count. Today itself is the date on the device clock (localTodayIso).
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

/**
 * A day as the app writes it, YYYY-MM-DD: only a string a UTC round trip gives back unchanged. The string check
 * comes first, because turning an object into text can throw. A date with extra text, or one that names no day
 * (2026-02-30: some engines roll it over to March 2, others give no date at all), fails. UTC on both sides, so the
 * device's time zone cannot move the day.
 */
export function isDay(v: unknown): v is string {
	if (typeof v !== 'string') return false;
	const t = new Date(`${v}T00:00:00Z`);
	return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

/**
 * Today as an ISO date, read from the device clock. A deadline is a calendar day where the user lives, and the
 * UTC date is already tomorrow on a US evening, so the UTC date would close a window a day early.
 */
export function localTodayIso(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
