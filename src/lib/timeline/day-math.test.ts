import { afterEach, describe, it, expect, vi } from 'vitest';
import { daysBetween, addDays, localTodayIso } from './day-math';
import { isDay } from './day-check';

describe('isDay', () => {
	it('accepts a day the app writes, including the leap day and the last day it can name', () => {
		for (const d of ['2026-10-04', '2028-02-29', '9999-12-30', '0001-01-01']) {
			expect(isDay(d), d).toBe(true);
		}
	});

	it('refuses anything a UTC round trip does not give back unchanged', () => {
		for (const d of [
			'2026-02-30',
			'2026-13-01',
			'2026-13-45',
			'2026-4-1',
			'2026-12-01x',
			'2026-12-01T00:00:00Z',
			'3abcdefghi',
			'10000-01-01',
			'',
			' 2026-10-04'
		]) {
			expect(isDay(d), d).toBe(false);
		}
	});

	it('refuses a value that is not a string without turning it into text', () => {
		for (const v of [null, undefined, 20261004, ['2026-10-04'], { toString: 0 }]) {
			expect(isDay(v)).toBe(false);
		}
	});
});

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

	// On a US New Year's Eve the UTC month and year are already the next ones, not only the UTC day.
	it("is the local year and month on a US New Year's Eve, not the UTC ones", () => {
		vi.stubEnv('TZ', 'America/Los_Angeles');
		const evening = new Date('2027-01-01T03:00:00Z');
		expect(evening.getHours()).toBe(19); // the zone took effect
		expect(localTodayIso(evening)).toBe('2026-12-31');
	});

	// Every machine and CI read the same day: the test projects run in one zone behind UTC (vite.config.ts), and a
	// zone a test stubs is put back afterwards rather than left for the tests after it.
	it('runs in the pinned zone, and gets it back after a stubbed one', () => {
		const instant = new Date('2027-01-01T03:00:00Z');
		expect(instant.getDate()).toBe(31); // Los Angeles: 19:00 on Dec 31
		vi.stubEnv('TZ', 'Asia/Tokyo');
		expect(instant.getDate()).toBe(1); // Tokyo: 12:00 on Jan 1
		vi.unstubAllEnvs();
		expect(instant.getDate()).toBe(31);
	});
});
