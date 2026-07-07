import { describe, it, expect } from 'vitest';
import {
	parseEaosCalendar,
	EaosFormatError,
	validateEaosAtInput,
	parseEaosAtRead,
	daysUntilSeparation,
	eaosOffsetDate,
	encodeEaos,
	decodeEaos,
	type EaosString
} from './eaos';

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

describe('parseEaosAtRead', () => {
	it('accepts calendar-valid dates regardless of range', () => {
		expect(parseEaosAtRead('2010-01-01')).toBe('2010-01-01');
		expect(parseEaosAtRead('2099-12-31')).toBe('2099-12-31');
	});

	it('rejects calendar-invalid dates', () => {
		expect(() => parseEaosAtRead('2027-02-30')).toThrow(EaosFormatError);
		expect(() => parseEaosAtRead('not-a-date')).toThrow(EaosFormatError);
	});

	it('does NOT apply input-range check (out-of-range past loads OK)', () => {
		// Simulates loading a profile saved 10 years ago
		expect(() => parseEaosAtRead('2015-01-01')).not.toThrow();
	});
});

describe('daysUntilSeparation', () => {
	it('returns positive integer days for future EAOS', () => {
		const eaos = '2027-04-15' as EaosString;
		const today = new Date('2026-05-26T12:00:00Z');
		expect(daysUntilSeparation(eaos, today)).toBe(324);
	});

	it('returns negative for past EAOS', () => {
		const eaos = '2025-05-26' as EaosString;
		const today = new Date('2026-05-26T12:00:00Z');
		expect(daysUntilSeparation(eaos, today)).toBe(-365);
	});

	it('returns 0 for EAOS = today', () => {
		const eaos = '2026-05-26' as EaosString;
		const today = new Date('2026-05-26T12:00:00Z');
		expect(daysUntilSeparation(eaos, today)).toBe(0);
	});

	it('is timezone-stable: two instants on the same UTC date return the same value', () => {
		const eaos = '2027-01-01' as EaosString;
		// 03:00 UTC and 23:00 UTC are the same UTC calendar date (2026-05-26);
		// UTC anchoring means time-of-day must not shift the day count.
		const early = new Date('2026-05-26T03:00:00Z');
		const late = new Date('2026-05-26T23:00:00Z');
		expect(daysUntilSeparation(eaos, early)).toBe(daysUntilSeparation(eaos, late));
	});

	it('handles leap-day arithmetic correctly', () => {
		const eaos = '2028-03-01' as EaosString;
		const today = new Date('2028-02-28T12:00:00Z');
		expect(daysUntilSeparation(eaos, today)).toBe(2); // Feb 29 + Mar 1
	});
});

describe('encodeEaos', () => {
	it('encodes an EAOS string to UTF-8 bytes that decode back to the same string', () => {
		const eaos = validateEaosAtInput('2027-04-30', new Date('2026-05-26T12:00:00Z'));
		const bytes = encodeEaos(eaos);
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(bytes)).toBe('2027-04-30');
	});

	it('produces bytes the read path (parseEaosAtRead) accepts unchanged', () => {
		const eaos = validateEaosAtInput('2025-12-01', new Date('2026-05-26T12:00:00Z'));
		const bytes = encodeEaos(eaos);
		expect(parseEaosAtRead(new TextDecoder().decode(bytes))).toBe('2025-12-01');
	});
});

describe('decodeEaos', () => {
	it('decodes UTF-8 bytes back to the EAOS string (inverse of encodeEaos)', () => {
		const eaos = validateEaosAtInput('2027-04-30', new Date('2026-05-26T12:00:00Z'));
		expect(decodeEaos(encodeEaos(eaos))).toBe('2027-04-30');
	});
});

describe('eaosOffsetDate', () => {
	it('projects a negative offset to the calendar date before EAOS', () => {
		// 2027-04-15 is day-of-year 105 (31+28+31+15); 105 - 90 = day 15 = Jan 15.
		const eaos = '2027-04-15' as EaosString;
		expect(eaosOffsetDate(eaos, -90)).toBe('2027-01-15');
	});

	it('crosses the leap day correctly (2028 is a leap year)', () => {
		// 2028-03-01 minus 2 days = Feb 28 (Mar 1 -> Feb 29 -> Feb 28).
		const eaos = '2028-03-01' as EaosString;
		expect(eaosOffsetDate(eaos, -2)).toBe('2028-02-28');
	});

	it('returns the EAOS itself for a zero offset', () => {
		const eaos = '2027-04-15' as EaosString;
		expect(eaosOffsetDate(eaos, 0)).toBe('2027-04-15');
	});

	it('projects a positive offset forward across a year boundary', () => {
		const eaos = '2027-12-31' as EaosString;
		expect(eaosOffsetDate(eaos, 1)).toBe('2028-01-01');
	});
});
