import { afterEach, describe, it, expect, vi } from 'vitest';
import { daysBetween, addDays, addYears, addYearsAndDays, localTodayIso } from './day-math';

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

describe('addYears', () => {
	it('keeps the month and day', () => {
		expect(addYears('2027-04-30', 1)).toBe('2028-04-30');
		expect(addYears('2026-01-31', 1)).toBe('2027-01-31');
	});

	it('moves a Feb 29 to Feb 28 in a year without one, never to Mar 1', () => {
		expect(addYears('2028-02-29', 1)).toBe('2029-02-28');
	});

	it('keeps a Feb 29 in a leap target year', () => {
		expect(addYears('2028-02-29', 4)).toBe('2032-02-29');
	});
});

// va.gov says "1 year and 120 days" and not which is counted first, so the edge is the earlier of the two orders:
// exact when they agree, never late when a Feb 29 makes them differ.
describe('addYearsAndDays', () => {
	it('is the same day when both orders agree', () => {
		expect(addYearsAndDays('2027-04-30', 1, 120)).toBe('2028-08-28');
	});

	it('takes the year-first day when the days-first order lands a day later', () => {
		// Year first: 2027-11-01 then 120 days = 2028-02-29. Days first: 2027-03-01 then 1 year = 2028-03-01.
		expect(addYearsAndDays('2026-11-01', 1, 120)).toBe('2028-02-29');
	});

	it('takes the days-first day when the year-first order lands a day later', () => {
		// Year first: 2028-11-01 then 120 days = 2029-03-01. Days first: 2028-02-29 then 1 year = 2029-02-28.
		expect(addYearsAndDays('2027-11-01', 1, 120)).toBe('2029-02-28');
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
