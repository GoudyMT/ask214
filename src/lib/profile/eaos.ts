/**
 * EAOS (End of Active Obligated Service) date validation primitives.
 *
 * Two validation paths per spec section 10:
 * - validateEaosAtInput: STRICT (input/edit; range-checked against today)
 * - parseEaosAtRead: LENIENT (load path; no range check; only calendar validity)
 *
 * Errors are PII-free: cause enum, never includes input string.
 * Date math is UTC-anchored to eliminate timezone off-by-one (F-C-9).
 *
 * Source: Phase 2 spec section 10 (EAOS validation contract).
 */

export type EaosString = string & { readonly __brand: 'EaosString' };

export type EaosCause = 'format' | 'year-range' | 'month' | 'day';

export class EaosFormatError extends Error {
	constructor(public override readonly cause: EaosCause) {
		super(`E_EAOS_${cause.toUpperCase().replace('-', '_')}`);
		this.name = 'EaosFormatError';
	}
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

function isLeapYear(y: number): boolean {
	return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
	if (m === 2) return isLeapYear(y) ? 29 : 28;
	if ([4, 6, 9, 11].includes(m)) return 30;
	return 31;
}

export function parseEaosCalendar(s: string): { y: number; m: number; d: number } {
	if (typeof s !== 'string' || s.length !== 10) {
		throw new EaosFormatError('format');
	}
	const match = ISO_DATE.exec(s);
	if (!match) throw new EaosFormatError('format');

	const y = Number(match[1]);
	const m = Number(match[2]);
	const d = Number(match[3]);

	if (y < MIN_YEAR || y > MAX_YEAR) throw new EaosFormatError('year-range');
	if (m < 1 || m > 12) throw new EaosFormatError('month');
	if (d < 1 || d > daysInMonth(y, m)) throw new EaosFormatError('day');

	return { y, m, d };
}

const PAST_YEARS = 5;
const FUTURE_YEARS = 15;

/**
 * Strict input-path validator: calendar-valid AND within [today - 5y, today + 15y].
 *
 * "today" is read via UTC getters so the comparison is anchored to the same UTC
 * calendar as the Date.UTC-built input value - no timezone off-by-one (F-C-9).
 */
export function validateEaosAtInput(s: string, today = new Date()): EaosString {
	const { y, m, d } = parseEaosCalendar(s);
	const inputUTC = Date.UTC(y, m - 1, d);
	const ty = today.getUTCFullYear();
	const tm = today.getUTCMonth();
	const td = today.getUTCDate();
	const minUTC = Date.UTC(ty - PAST_YEARS, tm, td);
	const maxUTC = Date.UTC(ty + FUTURE_YEARS, tm, td);
	if (inputUTC < minUTC || inputUTC > maxUTC) {
		throw new EaosFormatError('year-range');
	}
	return s as EaosString;
}
