import { addDays } from './day-math';

/**
 * Snooze presets + date math. snoozeUntilIso projects "today + N days" to a
 * UTC-anchored ISO date (YYYY-MM-DD) through the shared whole-day math, so the snooze-until
 * date never shifts by the runtime timezone. Presets are day-based ("1 month" = 30d, "3 months"
 * = 90d) - deterministic and matching the engine's day-offset model; the snoozed card shows the
 * exact resulting date, so the approximation is never hidden from the user.
 */

export type SnoozePreset = { label: string; days: number };

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
	{ label: '1 week', days: 7 },
	{ label: '1 month', days: 30 },
	{ label: '3 months', days: 90 }
];

export function snoozeUntilIso(today: Date, days: number): string {
	return addDays(today.toISOString().slice(0, 10), days);
}
