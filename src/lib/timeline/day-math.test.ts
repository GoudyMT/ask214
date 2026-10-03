import { describe, it, expect } from 'vitest';
import { daysBetween, addDays } from './day-math';

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
