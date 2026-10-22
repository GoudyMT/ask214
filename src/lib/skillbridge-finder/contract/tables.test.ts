import { describe, it, expect } from 'vitest';
import {
	MAX_CROSSWALK_ROWS,
	MAX_ROWS_PER_CODE,
	MAX_ZIP_ROWS,
	validateCrosswalk,
	validateZips
} from './tables';

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe('validateZips', () => {
	const zips = (rows: unknown[]) => ({ v: 1, rows });

	it('accepts five-digit ZIPs with a state and a point, including a leading zero', () => {
		expect(
			validateZips(
				zips([
					['21046', 'MD', 39.2, -76.86],
					['02134', 'MA', 42.35, -71.13]
				])
			)
		).toEqual({ valid: true, errors: [] });
	});

	// A ZIP is matched against what a person types; a malformed one would never match, or match the wrong place.
	// The state picks which division file the app fetches, so a state outside the contract would fetch nothing.
	it.each([
		[['2134', 'MA', 42.35, -71.13], 'E_SBF_BAD_ZIP'],
		[['21046-1234', 'MD', 39.2, -76.86], 'E_SBF_BAD_ZIP'],
		[['21046', 'MD', 91, -76.86], 'E_SBF_BAD_POINT'],
		[['21046', 'MD', 39.2, 'west'], 'E_SBF_BAD_POINT'],
		[['21046', 39.2, -76.86], 'E_SBF_BAD_ROW'],
		[['21046', 'MD', 39.2], 'E_SBF_BAD_ROW'],
		[['21046', 'ZZ', 39.2, -76.86], 'E_SBF_BAD_ENUM'],
		[['21046', 'OS', 39.2, -76.86], 'E_SBF_BAD_ENUM'],
		[['21046', 'Maryland', 39.2, -76.86], 'E_SBF_BAD_ENUM']
	])('refuses the row %j', (row, code) => {
		expect(codes(validateZips(zips([row])))).toEqual([code]);
	});

	it('refuses a ZIP listed twice', () => {
		expect(
			codes(
				validateZips(
					zips([
						['21046', 'MD', 39.2, -76.86],
						['21046', 'MD', 39.3, -76.8]
					])
				)
			)
		).toEqual(['E_SBF_DUP_ID']);
	});

	it('refuses more rows than the cap without walking them', () => {
		expect(validateZips(zips(new Array<unknown>(MAX_ZIP_ROWS + 1).fill(null))).errors).toEqual([
			{ code: 'E_SBF_TOO_MANY_ROWS', field: 'rows' }
		]);
	});

	it('refuses an unknown key and a future version', () => {
		expect(codes(validateZips({ v: 1, rows: [], note: 'x' }))).toEqual(['E_SBF_UNKNOWN_FIELD']);
		expect(codes(validateZips({ v: 2, rows: [] }))).toEqual(['E_SBF_BAD_VERSION']);
	});
});

describe('validateCrosswalk', () => {
	const crosswalk = (rows: unknown[]) => ({ v: 1, rows });

	it('accepts a military code mapped to an O*NET occupation', () => {
		expect(
			validateCrosswalk(
				crosswalk([['91B', 'Army', '49-3023.00', 'Automotive Service Technicians']])
			)
		).toEqual({ valid: true, errors: [] });
	});

	it.each([
		[['91 B', 'Army', '49-3023.00', 'Automotive Service Technicians'], 'E_SBF_BAD_CODES'],
		[['91B', 'Militia', '49-3023.00', 'Automotive Service Technicians'], 'E_SBF_BAD_ENUM'],
		[['91B', 'Army', '49-3023', 'Automotive Service Technicians'], 'E_SBF_BAD_CODES'],
		[['91B', 'Army', '49-3023.00', 'a'.repeat(151)], 'E_SBF_TOO_LONG'],
		[['91B', 'Army', '49-3023.00', 'Technicians <b>Lead</b>'], 'E_SBF_BAD_TEXT']
	])('refuses the row %j', (row, code) => {
		expect(codes(validateCrosswalk(crosswalk([row])))).toEqual([code]);
	});

	it('refuses more rows than the cap without walking them', () => {
		expect(
			codes(validateCrosswalk(crosswalk(new Array<unknown>(MAX_CROSSWALK_ROWS + 1).fill(null))))
		).toEqual(['E_SBF_TOO_MANY_ROWS']);
	});

	// One code with thousands of rows makes every search that touches it walk them all.
	it('refuses a military code with more than 50 rows, and keeps one with exactly 50', () => {
		const rowsFor = (n: number) =>
			Array.from({ length: n }, (_, k) => ['11B', 'Army', `49-${1000 + k}.00`, 'Infantry']);
		expect(validateCrosswalk(crosswalk(rowsFor(MAX_ROWS_PER_CODE)))).toEqual({
			valid: true,
			errors: []
		});
		expect(validateCrosswalk(crosswalk(rowsFor(MAX_ROWS_PER_CODE + 1))).errors).toEqual([
			{ code: 'E_SBF_TOO_MANY_ROWS', field: 'rows' }
		]);
	});

	it('refuses the same military code and O*NET code listed twice', () => {
		const row = ['91B', 'Army', '49-3023.00', 'Automotive Service Technicians'];
		expect(codes(validateCrosswalk(crosswalk([row, [...row]])))).toEqual(['E_SBF_DUP_ID']);
		expect(
			validateCrosswalk(crosswalk([row, ['91B', 'Army', '49-3031.00', 'Bus Mechanics']])).valid
		).toBe(true);
	});
});
