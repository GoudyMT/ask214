/**
 * Format an engine ISO date (YYYY-MM-DD, UTC-anchored from eaosOffsetDate) as the human
 * "Mon D, YYYY" form the timeline cards + the /timeline subline display (raw ISO stays the
 * storage/anchoring form). Maps the calendar parts directly - no Date
 * instant, no toLocale or Intl - so the output is deterministic and never shifts by the runtime
 * timezone or ICU locale data. Input is always a valid engine ISO date, so no validation branch.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTimelineDate(iso: string): string {
	const [year, month, day] = iso.split('-');
	return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}
