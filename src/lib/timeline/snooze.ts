import { addDays, localTodayIso } from './day-math';

/**
 * Snooze presets + date math. snoozeUntilIso projects "today + N days" from the date on the
 * device clock through the shared whole-day math, so a snooze set on a US evening counts from
 * that evening's date, not the UTC one. Presets are day-based ("1 month" = 30d, "3 months"
 * = 90d) - deterministic and matching the engine's day-offset model; the snoozed card shows the
 * exact resulting date, so the approximation is never hidden from the user.
 */

export type SnoozePreset = { label: string; days: number };

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
	{ label: '1 week', days: 7 },
	{ label: '1 month', days: 30 },
	{ label: '3 months', days: 90 }
];

// The calendar event of a snoozed soft task ends the next day, and a year past 9999 is not a calendar date, so the
// latest date a snooze can name is the one before the last day of year 9999.
export const SNOOZE_DATE_MAX = '9999-12-30';

export function snoozeUntilIso(today: Date, days: number): string {
	return addDays(localTodayIso(today), days);
}
