import { afterEach, describe, it, expect, vi } from 'vitest';
import { SNOOZE_PRESETS, snoozeUntilIso } from './snooze';

// Snooze presets + date math. snoozeUntilIso projects "today + N days" from the date on the
// device clock. Presets are day-based (1 month = 30d, 3 months = 90d) - deterministic and
// matching the engine's day-offset model; the snoozed card shows the exact resulting date.

afterEach(() => {
	vi.unstubAllEnvs();
});

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

	it('counts from the local date, the same all through a local day', () => {
		vi.stubEnv('TZ', 'America/Los_Angeles');
		// 00:30 and 23:30 on June 6 in Los Angeles; the later one is already June 7 in UTC.
		const early = new Date('2026-06-06T07:30:00Z');
		const late = new Date('2026-06-07T06:30:00Z');
		expect([early.getDate(), late.getDate()]).toEqual([6, 6]); // the zone took effect
		expect(snoozeUntilIso(early, 7)).toBe('2026-06-13');
		expect(snoozeUntilIso(late, 7)).toBe('2026-06-13');
	});
});
