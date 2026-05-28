import { describe, it, expect } from 'vitest';
import { parseEaosCalendar, EaosFormatError, validateEaosAtInput } from './eaos';

describe('parseEaosCalendar', () => {
	it('parses a valid date', () => {
		const r = parseEaosCalendar('2027-04-15');
		expect(r).toEqual({ y: 2027, m: 4, d: 15 });
	});

	it('rejects malformed input with cause=format', () => {
		expect(() => parseEaosCalendar('2027/04/15')).toThrow(EaosFormatError);
		try {
			parseEaosCalendar('2027/04/15');
		} catch (e) {
			expect((e as EaosFormatError).cause).toBe('format');
			expect((e as EaosFormatError).message).toBe('E_EAOS_FORMAT');
		}
	});

	it('rejects out-of-range year with cause=year-range', () => {
		expect(() => parseEaosCalendar('1899-12-31')).toThrow(EaosFormatError);
		try {
			parseEaosCalendar('1899-12-31');
		} catch (e) {
			expect((e as EaosFormatError).cause).toBe('year-range');
		}
		expect(() => parseEaosCalendar('2201-01-01')).toThrow();
	});

	it('rejects out-of-range month with cause=month', () => {
		expect(() => parseEaosCalendar('2027-00-15')).toThrow(EaosFormatError);
		expect(() => parseEaosCalendar('2027-13-15')).toThrow(EaosFormatError);
		try {
			parseEaosCalendar('2027-13-15');
		} catch (e) {
			expect((e as EaosFormatError).cause).toBe('month');
		}
	});

	it('rejects invalid day for month with cause=day', () => {
		expect(() => parseEaosCalendar('2027-04-31')).toThrow(EaosFormatError);
		expect(() => parseEaosCalendar('2027-02-29')).toThrow(EaosFormatError);
		try {
			parseEaosCalendar('2027-02-29');
		} catch (e) {
			expect((e as EaosFormatError).cause).toBe('day');
		}
	});

	it('accepts leap-year Feb 29', () => {
		expect(() => parseEaosCalendar('2028-02-29')).not.toThrow();
		// 2000 is divisible by 400 -> leap; in-range (the divisible-by-400 century
		// rule, without using 2400 which exceeds the locked MAX_YEAR of 2200).
		expect(() => parseEaosCalendar('2000-02-29')).not.toThrow();
	});

	it('rejects non-leap-year Feb 29 (century rule)', () => {
		// 1900 is NOT a leap year (divisible by 100 but not 400)
		expect(() => parseEaosCalendar('1900-02-29')).toThrow();
		expect(() => parseEaosCalendar('2100-02-29')).toThrow();
	});

	it('rejects empty/whitespace/wrong-length inputs without echoing input', () => {
		for (const bad of ['', ' ', '2027', '2027-04', '2027-04-15-extra']) {
			try {
				parseEaosCalendar(bad);
			} catch (e) {
				expect((e as EaosFormatError).message).toBe('E_EAOS_FORMAT');
				// '' is a substring of every string, so the no-echo assertion only
				// applies to non-empty inputs (avoids the includes('') always-true trap).
				if (bad.length > 0) {
					expect((e as Error).message).not.toContain(bad);
				}
			}
		}
	});
});

describe('validateEaosAtInput', () => {
	it('returns branded EaosString for valid in-range date', () => {
		const today = new Date('2026-05-26T12:00:00Z');
		const r = validateEaosAtInput('2027-04-15', today);
		expect(r).toBe('2027-04-15');
		// brand check is compile-time only; runtime is the same string
	});

	it('rejects calendar-invalid input with EaosFormatError', () => {
		const today = new Date('2026-05-26T12:00:00Z');
		expect(() => validateEaosAtInput('2027-13-15', today)).toThrow(EaosFormatError);
	});

	it('rejects too-far-past input (>5 years ago) with year-range cause', () => {
		const today = new Date('2026-05-26T12:00:00Z');
		expect(() => validateEaosAtInput('2020-05-25', today)).toThrow(EaosFormatError);
		try {
			validateEaosAtInput('2020-05-25', today);
		} catch (e) {
			expect((e as EaosFormatError).cause).toBe('year-range');
		}
	});

	it('rejects too-far-future input (>15 years out) with year-range cause', () => {
		const today = new Date('2026-05-26T12:00:00Z');
		expect(() => validateEaosAtInput('2041-05-27', today)).toThrow(EaosFormatError);
	});

	it('accepts exactly 5 years ago to the day', () => {
		const today = new Date('2026-05-26T12:00:00Z');
		expect(() => validateEaosAtInput('2021-05-26', today)).not.toThrow();
	});

	it('accepts exactly 15 years from now', () => {
		const today = new Date('2026-05-26T12:00:00Z');
		expect(() => validateEaosAtInput('2041-05-26', today)).not.toThrow();
	});
});
