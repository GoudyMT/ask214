import { describe, it, expect } from 'vitest';
import {
	MAX_BASE_ROWS,
	MAX_CROSSWALK_ROWS,
	MAX_ZIP_ROWS,
	validateBases,
	validateCrosswalk,
	validateZips
} from './tables';

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe('validateZips', () => {
	const zips = (rows: unknown[]) => ({ v: 1, rows });

	it('accepts five-digit ZIPs with a point, including a leading zero', () => {
		expect(
			validateZips(
				zips([
					['21046', 39.2, -76.86],
					['02134', 42.35, -71.13]
				])
			)
		).toEqual({ valid: true, errors: [] });
	});

	// A ZIP is matched against what a person types; a malformed one would never match, or match the wrong place.
	it.each([
		[['2134', 42.35, -71.13], 'E_SBF_BAD_ZIP'],
		[['21046-1234', 39.2, -76.86], 'E_SBF_BAD_ZIP'],
		[['21046', 91, -76.86], 'E_SBF_BAD_POINT'],
		[['21046', 39.2, 'west'], 'E_SBF_BAD_POINT'],
		[['21046', 39.2], 'E_SBF_BAD_ROW']
	])('refuses the row %j', (row, code) => {
		expect(codes(validateZips(zips([row])))).toEqual([code]);
	});

	it('refuses a ZIP listed twice', () => {
		expect(
			codes(
				validateZips(
					zips([
						['21046', 39.2, -76.86],
						['21046', 39.3, -76.8]
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

describe('validateBases', () => {
	const bases = (rows: unknown[]) => ({ v: 1, rows });

	it('accepts a named installation with its state and point', () => {
		expect(validateBases(bases([['Fort Example', 'TX', 31.13, -97.78]]))).toEqual({
			valid: true,
			errors: []
		});
	});

	it.each([
		[['Fort <b>Example</b>', 'TX', 31.13, -97.78], 'E_SBF_BAD_TEXT'],
		[['a'.repeat(151), 'TX', 31.13, -97.78], 'E_SBF_TOO_LONG'],
		[['Fort Example', 'Texas', 31.13, -97.78], 'E_SBF_BAD_ENUM'],
		[['Fort Example', 'TX', 31.13, 181], 'E_SBF_BAD_POINT']
	])('refuses the row %j', (row, code) => {
		expect(codes(validateBases(bases([row])))).toEqual([code]);
	});

	it('refuses more rows than the cap without walking them', () => {
		expect(codes(validateBases(bases(new Array<unknown>(MAX_BASE_ROWS + 1).fill(null))))).toEqual([
			'E_SBF_TOO_MANY_ROWS'
		]);
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
});
