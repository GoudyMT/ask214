import { describe, it, expect } from 'vitest';
import { SNOOZE_PRESETS, snoozeUntilIso } from './snooze';

// Snooze presets + date math. snoozeUntilIso projects "today + N days" to a
// UTC-anchored ISO date (same pattern as eaosOffsetDate), so the result never shifts by the
// runtime timezone. Presets are day-based (1 month = 30d, 3 months = 90d) - deterministic and
// matching the engine's day-offset model; the snoozed card shows the exact resulting date.

describe('snooze presets', () => {
	it('exposes 1 week / 1 month / 3 months presets (in days)', () => {
		expect(SNOOZE_PRESETS.map((p) => p.label)).toEqual(['1 week', '1 month', '3 months']);
		expect(SNOOZE_PRESETS.map((p) => p.days)).toEqual([7, 30, 90]);
	});

	it('computes the snooze-until ISO date N days from today', () => {
		const today = new Date('2026-06-06T12:00:00Z');
		expect(snoozeUntilIso(today, 7)).toBe('2026-06-13');
		expect(snoozeUntilIso(today, 30)).toBe('2026-07-06');
		expect(snoozeUntilIso(today, 90)).toBe('2026-09-04');
	});

	it('is time-of-day independent (UTC calendar date only)', () => {
		const early = new Date('2026-06-06T00:30:00Z');
		const late = new Date('2026-06-06T23:30:00Z');
		expect(snoozeUntilIso(early, 7)).toBe(snoozeUntilIso(late, 7));
	});
});
