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
 * The ISO date `years` after `iso`, on the same month and day. A Feb 29 in a year without one becomes Feb 28, the
 * earlier day, so a deadline counted this way is never late.
 */
export function addYears(iso: string, years: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	const target = y! + years;
	const isLeap = (target % 4 === 0 && target % 100 !== 0) || target % 400 === 0;
	const day = m === 2 && d === 29 && !isLeap ? 28 : d!;
	return new Date(Date.UTC(target, m! - 1, day)).toISOString().slice(0, 10);
}

/**
 * `years` and `days` after `iso`. A source that says "1 year and 120 days" does not say which part is counted first,
 * and a Feb 29 in between makes the two orders differ by a day. The earlier of the two is exact when they agree and
 * never late when they differ.
 */
export function addYearsAndDays(iso: string, years: number, days: number): string {
	const yearFirst = addDays(addYears(iso, years), days);
	const daysFirst = addYears(addDays(iso, days), years);
	return yearFirst < daysFirst ? yearFirst : daysFirst;
}

/**
 * Today as an ISO date, read from the device clock. A deadline is a calendar day where the user lives, and the
 * UTC date is already tomorrow on a US evening, so the UTC date would close a window a day early.
 */
export function localTodayIso(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
