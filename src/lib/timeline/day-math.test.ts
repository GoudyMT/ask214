import { afterEach, describe, it, expect, vi } from 'vitest';
import { daysBetween, addDays, localTodayIso } from './day-math';

describe('daysBetween', () => {
	it('counts whole calendar days, positive when the second date is later', () => {
		expect(daysBetween('2026-10-03', '2026-10-20')).toBe(17);
		expect(daysBetween('2026-10-20', '2026-10-03')).toBe(-17);
		expect(daysBetween('2026-10-03', '2026-10-03')).toBe(0);
	});

	it('crosses month, year and leap-day boundaries', () => {
		expect(daysBetween('2027-01-18', '2028-05-17')).toBe(485);
		expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
	});
});

describe('addDays', () => {
	it('moves forward and back by whole days', () => {
		expect(addDays('2026-10-20', -30)).toBe('2026-09-20');
		expect(addDays('2027-01-18', 240)).toBe('2027-09-15');
	});
});

// A deadline is a calendar day where the user lives. The same instant is already tomorrow in UTC on a US evening
// and still yesterday in UTC on an Asian morning, so today is read from the device clock.
describe('localTodayIso', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('is the date on the device clock on a US evening, not the UTC date', () => {
		vi.stubEnv('TZ', 'America/Los_Angeles');
		const evening = new Date('2026-10-04T01:00:00Z');
		expect(evening.getHours()).toBe(18); // the zone took effect
		expect(localTodayIso(evening)).toBe('2026-10-03');
	});

	it('is the date on the device clock on a Tokyo morning, not the UTC date', () => {
		vi.stubEnv('TZ', 'Asia/Tokyo');
		const morning = new Date('2026-10-03T23:30:00Z');
		expect(morning.getHours()).toBe(8); // the zone took effect
		expect(localTodayIso(morning)).toBe('2026-10-04');
	});
});
