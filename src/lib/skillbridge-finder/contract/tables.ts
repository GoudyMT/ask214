/**
 * The supporting tables served whole beside the listings: ZIP points for distance and the military-to-civilian
 * crosswalk for search. Written by the pipeline from public datasets and read by the app, both through these
 * validators. Rows are arrays rather than objects because the ZIP table alone holds about 33,000 of them and every
 * repeated key would be downloaded.
 */

import { BRANCHES, CONTRACT_VERSION } from './listing';
import { STATE_CODES, type StateCode } from './places';
import { isSafeText, type ContractError, type ContractResult } from './validate';

export const MAX_ZIP_ROWS = 40_000;
export const MAX_CROSSWALK_ROWS = 100_000;
/** One military code maps to a handful of O*NET jobs; more than this is a broken or hostile table. */
export const MAX_ROWS_PER_CODE = 50;
const MAX_NAME = 150;

/**
 * `[zip, state, lat, lon]`: one row per five-digit ZIP code tabulation area. The state lets a search with no
 * radius fetch that state's division alone instead of guessing from the point.
 */
export type ZipsTable = { v: 1; rows: [string, StateCode, number, number][] };
/**
 * `[military code, branch, O*NET-SOC code, O*NET title]`. The column set is confirmed against the O*NET file
 * when the pipeline first reads it.
 */
export type CrosswalkTable = { v: 1; rows: [string, string, string, string][] };

const ZIP_RE = /^\d{5}$/;
const MILITARY_CODE_RE = /^[0-9A-Z]{2,6}$/;
const ONET_CODE_RE = /^\d{2}-\d{4}\.\d{2}$/;
const BRANCH_SET: ReadonlySet<unknown> = new Set(BRANCHES);
const STATE_SET: ReadonlySet<unknown> = new Set(STATE_CODES);

const isPoint = (la: unknown, lo: unknown) =>
	typeof la === 'number' &&
	typeof lo === 'number' &&
	Number.isFinite(la) &&
	Number.isFinite(lo) &&
	Math.abs(la) <= 90 &&
	Math.abs(lo) <= 180;

/** Shared shape check; returns the rows to walk, or null when the table is refused as a whole. */
function readTable(raw: unknown, maxRows: number, errors: ContractError[]): unknown[] | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		errors.push({ code: 'E_SBF_NOT_OBJECT' });
		return null;
	}
	const table = raw as Record<string, unknown>;
	for (const key of Object.keys(table))
		if (key !== 'v' && key !== 'rows') errors.push({ code: 'E_SBF_UNKNOWN_FIELD', field: key });
	if (table.v !== CONTRACT_VERSION) errors.push({ code: 'E_SBF_BAD_VERSION', field: 'v' });
	if (!Array.isArray(table.rows)) {
		errors.push({ code: 'E_SBF_BAD_TYPE', field: 'rows' });
		return null;
	}
	// Checked before any row is read, so an oversized table costs nothing to refuse.
	if (table.rows.length > maxRows) {
		errors.push({ code: 'E_SBF_TOO_MANY_ROWS', field: 'rows' });
		return null;
	}
	return table.rows;
}

const result = (errors: ContractError[]): ContractResult => ({
	valid: errors.length === 0,
	errors
});

function rowOf(row: unknown, width: number, errors: ContractError[]): unknown[] | null {
	if (Array.isArray(row) && row.length === width) return row;
	errors.push({ code: 'E_SBF_BAD_ROW', field: 'rows' });
	return null;
}

export function validateZips(raw: unknown): ContractResult {
	const errors: ContractError[] = [];
	const rows = readTable(raw, MAX_ZIP_ROWS, errors);
	const seen = new Set<string>();
	for (const r of rows ?? []) {
		const row = rowOf(r, 4, errors);
		if (row === null) continue;
		const [zip, state, la, lo] = row;
		if (typeof zip !== 'string' || !ZIP_RE.test(zip)) {
			errors.push({ code: 'E_SBF_BAD_ZIP', field: 'rows' });
			continue;
		}
		if (!STATE_SET.has(state)) errors.push({ code: 'E_SBF_BAD_ENUM', field: 'rows' });
		if (!isPoint(la, lo)) errors.push({ code: 'E_SBF_BAD_POINT', field: 'rows' });
		if (seen.has(zip)) errors.push({ code: 'E_SBF_DUP_ID', field: 'rows' });
		seen.add(zip);
	}
	return result(errors);
}

export function validateCrosswalk(raw: unknown): ContractResult {
	const errors: ContractError[] = [];
	const rows = readTable(raw, MAX_CROSSWALK_ROWS, errors);
	const perCode = new Map<string, Set<string>>();
	const pairs = new Set<string>();
	for (const r of rows ?? []) {
		const row = rowOf(r, 4, errors);
		if (row === null) continue;
		const [code, branch, onetCode, title] = row;
		if (
			typeof code !== 'string' ||
			!MILITARY_CODE_RE.test(code) ||
			typeof onetCode !== 'string' ||
			!ONET_CODE_RE.test(onetCode)
		)
			errors.push({ code: 'E_SBF_BAD_CODES', field: 'rows' });
		else {
			// Search walks every occupation of a code it is given, so a code with thousands of them, or one row repeated,
			// is cost with no meaning. A code shared by two branches (Navy and Coast Guard ratings) folds into one set of
			// occupations, so the cap counts distinct occupations. The excess is reported once per code.
			const onets = perCode.get(code) ?? new Set<string>();
			perCode.set(code, onets);
			if (!onets.has(onetCode) && onets.add(onetCode).size === MAX_ROWS_PER_CODE + 1)
				errors.push({ code: 'E_SBF_TOO_MANY_ROWS', field: 'rows' });
			const pair = `${code} ${String(branch)} ${onetCode}`;
			if (pairs.has(pair)) errors.push({ code: 'E_SBF_DUP_ID', field: 'rows' });
			pairs.add(pair);
		}
		if (!BRANCH_SET.has(branch)) errors.push({ code: 'E_SBF_BAD_ENUM', field: 'rows' });
		if (!isSafeText(title)) errors.push({ code: 'E_SBF_BAD_TEXT', field: 'rows' });
		else if (title.length > MAX_NAME) errors.push({ code: 'E_SBF_TOO_LONG', field: 'rows' });
	}
	return result(errors);
}
