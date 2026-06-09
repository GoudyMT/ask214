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

/**
 * Lenient load-path validator: calendar validity only, NO input-range check.
 * A profile saved years ago must still load without rejection.
 */
export function parseEaosAtRead(s: string): EaosString {
	parseEaosCalendar(s); // validation only; throws on invalid
	return s as EaosString;
}

/**
 * Encode a validated EAOS string to UTF-8 bytes for at-rest storage. ProfileV1.eaos is a
 * Uint8Array (so zeroizeField can wipe it on relock); this is the exact inverse of the
 * read-path decode (`new TextDecoder().decode(...)`) in derivePersona.
 */
export function encodeEaos(eaos: EaosString): Uint8Array {
	return new TextEncoder().encode(eaos);
}

/**
 * Decode at-rest EAOS bytes back to string form (e.g. the Settings editor's initial value).
 * Inverse of encodeEaos; calendar-validity re-checking lives in parseEaosAtRead, not here.
 */
export function decodeEaos(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

const MS_PER_DAY = 86_400_000;

/**
 * Whole-day count from "today" to the EAOS. Both ends are UTC-anchored (the EAOS
 * via Date.UTC, "today" via UTC getters) so neither timezone nor time-of-day can
 * shift the result (F-C-9). Positive = future, negative = past, 0 = today.
 */
export function daysUntilSeparation(eaos: EaosString, now = new Date()): number {
	const { y, m, d } = parseEaosCalendar(eaos);
	const eaosUTC = Date.UTC(y, m - 1, d);
	const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return Math.round((eaosUTC - todayUTC) / MS_PER_DAY);
}

/**
 * Project an EAOS-relative offset to an absolute UTC calendar date (YYYY-MM-DD).
 *
 * The Timeline Engine anchors every task to the separation date: a task's target
 * date is EAOS shifted by its day offset (negative = before separation). Both ends
 * are UTC-anchored (EAOS via Date.UTC, output via toISOString) so neither timezone
 * nor time-of-day can shift the result by a day (F-C-9, same as daysUntilSeparation).
 *
 * Returns a plain ISO date string, not a branded EaosString - the projection is a
 * derived target date, not a user-entered/validated EAOS.
 */
export function eaosOffsetDate(eaos: EaosString, offsetDays: number): string {
	const { y, m, d } = parseEaosCalendar(eaos);
	const ms = Date.UTC(y, m - 1, d) + offsetDays * MS_PER_DAY;
	return new Date(ms).toISOString().slice(0, 10);
}
