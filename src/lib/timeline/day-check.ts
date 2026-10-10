/**
 * Checks on a stored day that need none of the day arithmetic. The stores' decoders run them on every page, so they
 * live apart from day-math and the snooze presets, which only the pages that show dates load.
 */

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

// The calendar event of a snoozed soft task ends the next day, and a year past 9999 is not a calendar date, so the
// latest date a snooze can name is the one before the last day of year 9999.
export const SNOOZE_DATE_MAX = '9999-12-30';
