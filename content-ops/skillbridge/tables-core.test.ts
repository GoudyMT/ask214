import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
	crosswalkFromCsv,
	DEFAULT_REALPATH,
	isInsideFolder,
	stateExtentsFromCounties,
	stateExtentsSource,
	zipsFromGazetteer,
	type StateExtent
} from './tables-core.ts';
import type { StateCode } from '../../src/lib/skillbridge-finder/contract/places.ts';
import {
	validateCrosswalk,
	validateZips
} from '../../src/lib/skillbridge-finder/contract/tables.ts';

const failure = (run: () => unknown) => {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : 'NOT_AN_ERROR';
	}
	return 'NO_ERROR';
};

describe('zipsFromGazetteer', () => {
	const HEADER = 'GEOID|GEOIDFQ|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG';
	const line = (geoid: string, lat: string, lon: string) =>
		`${geoid}|860Z200US${geoid}|1|2|3|4|${lat}|${lon}`;
	const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';

	// The Census ZCTA-to-county relationship file, in its published column order; one row per ZCTA and county.
	const REL_HEADER = [
		'OID_ZCTA5_20',
		'GEOID_ZCTA5_20',
		'NAMELSAD_ZCTA5_20',
		'AREALAND_ZCTA5_20',
		'AREAWATER_ZCTA5_20',
		'MTFCC_ZCTA5_20',
		'CLASSFP_ZCTA5_20',
		'FUNCSTAT_ZCTA5_20',
		'OID_COUNTY_20',
		'GEOID_COUNTY_20',
		'NAMELSAD_COUNTY_20',
		'AREALAND_COUNTY_20',
		'AREAWATER_COUNTY_20',
		'MTFCC_COUNTY_20',
		'CLASSFP_COUNTY_20',
		'FUNCSTAT_COUNTY_20',
		'AREALAND_PART',
		'AREAWATER_PART'
	].join('|');
	const part = (zip: string, county: string, land: string, water = '0') =>
		[
			'1',
			zip,
			zip === '' ? '' : `ZCTA5 ${zip}`,
			'9',
			'9',
			zip === '' ? '' : 'G6350',
			zip === '' ? '' : 'B5',
			zip === '' ? '' : 'S',
			'2',
			county,
			'Example County',
			'9',
			'9',
			'G4020',
			'H1',
			'A',
			land,
			water
		].join('|');
	const rel = (...lines: string[]) => [REL_HEADER, ...lines].join('\n') + '\n';

	// The counties gazetteer: only USPS and GEOID (the state FIPS is the GEOID's first two digits) are read.
	const COUNTIES_HEADER =
		'USPS|GEOID|GEOIDFQ|ANSICODE|NAME|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG';
	const county = (usps: string, geoid: string) =>
		`${usps}|${geoid}|0500000US${geoid}|0|Example County|1|1|0|0|39.0|-77.0`;
	const counties = (...lines: string[]) => [COUNTIES_HEADER, ...lines].join('\n') + '\n';
	const COUNTIES = counties(
		county('MD', '24001'),
		county('MD', '24510'),
		county('VA', '51059'),
		county('DC', '11001'),
		county('MA', '25025'),
		county('PR', '72001')
	);

	const reversed = (text: string) =>
		text
			.split('\n')
			.map((l) => l.split('|').reverse().join('|'))
			.join('\n');

	const BASIC_ZCTA = file(line('21046', '39.18921', '-76.86012'));
	const BASIC_REL = rel(part('21046', '24001', '500'));

	it('gives one rounded row per ZIP with its state, sorted, in a table the app accepts', () => {
		const table = zipsFromGazetteer(
			file(
				line('21046', '39.18921', '-76.86012'),
				line('00601', '18.180621', '-66.749931'),
				line('02134', '42.3551', '-71.1304')
			),
			rel(
				part('21046', '24001', '500'),
				part('00601', '72001', '70'),
				part('02134', '25025', '30')
			),
			COUNTIES
		);
		expect(table).toEqual({
			v: 1,
			rows: [
				['00601', 'PR', 18.181, -66.75],
				['02134', 'MA', 42.355, -71.13],
				['21046', 'MD', 39.189, -76.86]
			]
		});
		expect(validateZips(table)).toEqual({ valid: true, errors: [] });
	});

	it('reads Windows line ends the same as Unix ones', () => {
		const crlf = (text: string) => text.replaceAll('\n', '\r\n');
		expect(zipsFromGazetteer(crlf(BASIC_ZCTA), crlf(BASIC_REL), crlf(COUNTIES))).toEqual(
			zipsFromGazetteer(BASIC_ZCTA, BASIC_REL, COUNTIES)
		);
	});

	it('finds columns by name in all three files, whatever their order', () => {
		const shuffled = 'INTPTLONG|X|GEOID|INTPTLAT\n-76.86012|a|21046|39.18921\n';
		expect(zipsFromGazetteer(shuffled, reversed(BASIC_REL), reversed(COUNTIES)).rows).toEqual([
			['21046', 'MD', 39.189, -76.86]
		]);
	});

	describe('the state of a ZIP', () => {
		const stateOf = (...lines: string[]) =>
			zipsFromGazetteer(BASIC_ZCTA, rel(...lines), COUNTIES).rows[0]?.[1];

		it('is the state of its county, for a ZIP in more than one county of that state', () => {
			expect(stateOf(part('21046', '24001', '300'), part('21046', '24510', '200'))).toBe('MD');
		});

		// A rule that took the largest single part would pick DC here; the state is the one holding the most land.
		it('is the state holding the most land, summed over its counties', () => {
			expect(
				stateOf(
					part('21046', '11001', '100'),
					part('21046', '24001', '90'),
					part('21046', '24510', '30')
				)
			).toBe('MD');
		});

		it('breaks a land tie by the larger water, whatever the order of the rows', () => {
			expect(stateOf(part('21046', '24001', '100', '5'), part('21046', '51059', '100', '7'))).toBe(
				'VA'
			);
			expect(stateOf(part('21046', '51059', '100', '7'), part('21046', '24001', '100', '5'))).toBe(
				'VA'
			);
		});

		it('breaks a land and water tie by the lower state code, whatever the order of the rows', () => {
			expect(stateOf(part('21046', '51059', '100', '5'), part('21046', '24001', '100', '5'))).toBe(
				'MD'
			);
			expect(stateOf(part('21046', '24001', '100', '5'), part('21046', '51059', '100', '5'))).toBe(
				'MD'
			);
		});

		it('ignores rows of ZCTAs that are not in the gazetteer, and counties with no ZCTA', () => {
			const table = zipsFromGazetteer(
				BASIC_ZCTA,
				rel(
					part('', '24510', '1'),
					part('21046', '24001', '500'),
					part('90210', '99001', '500'),
					part('', '', '0')
				),
				COUNTIES
			);
			expect(table.rows).toEqual([['21046', 'MD', 39.189, -76.86]]);
		});
	});

	it.each([
		[
			'a ZIP with no row in the relationship file',
			BASIC_ZCTA,
			rel(part('21047', '24001', '500')),
			COUNTIES
		],
		[
			'a ZIP whose county state FIPS is not in the counties file',
			BASIC_ZCTA,
			rel(part('21046', '99001', '500')),
			COUNTIES
		],
		[
			'a ZIP whose state is not one of the contract states',
			BASIC_ZCTA,
			BASIC_REL,
			counties(county('ZZ', '24001'))
		],
		[
			'a ZIP with one county in a state the counties file does not know, beside a larger known one',
			BASIC_ZCTA,
			rel(part('21046', '24001', '500'), part('21046', '99001', '1')),
			COUNTIES
		]
	])('fails the build for %s rather than guessing a state', (_name, zcta, relationship, list) => {
		expect(failure(() => zipsFromGazetteer(zcta, relationship, list))).toBe('E_ZIP_NO_STATE');
	});

	it.each([
		['a 4-digit GEOID', file(line('1046', '39.1', '-76.8')), BASIC_REL, COUNTIES, 'E_TABLE_LINE'],
		[
			'a letter in a GEOID',
			file(line('2104a', '39.1', '-76.8')),
			BASIC_REL,
			COUNTIES,
			'E_TABLE_LINE'
		],
		[
			'a line with 7 fields',
			file('21046|860Z200US21046|1|2|3|39.1|-76.8'),
			BASIC_REL,
			COUNTIES,
			'E_TABLE_LINE'
		],
		[
			'a latitude that is not a number',
			file(line('21046', 'north', '-76.8')),
			BASIC_REL,
			COUNTIES,
			'E_TABLE_LINE'
		],
		['an empty longitude', file(line('21046', '39.1', '')), BASIC_REL, COUNTIES, 'E_TABLE_LINE'],
		[
			'a repeated GEOID',
			file(line('21046', '39.1', '-76.8'), line('21046', '39.2', '-76.9')),
			BASIC_REL,
			COUNTIES,
			'E_TABLE_LINE'
		],
		[
			'a blank line between rows',
			file(line('21046', '39.1', '-76.8'), '', line('21047', '39.1', '-76.8')),
			BASIC_REL,
			COUNTIES,
			'E_TABLE_LINE'
		],
		[
			'a latitude past the poles',
			file(line('21046', '95.1', '-76.8')),
			BASIC_REL,
			COUNTIES,
			'E_TABLE_INVALID'
		],
		[
			'a header without INTPTLONG',
			HEADER.replace('INTPTLONG', 'LONG') + '\n',
			BASIC_REL,
			COUNTIES,
			'E_TABLE_HEADER'
		],
		['no header at all', '', BASIC_REL, COUNTIES, 'E_TABLE_HEADER'],
		[
			'a relationship header without AREALAND_PART',
			BASIC_ZCTA,
			BASIC_REL.replace('AREALAND_PART', 'AREALAND'),
			COUNTIES,
			'E_TABLE_HEADER'
		],
		[
			'a relationship file with commas for delimiters',
			BASIC_ZCTA,
			BASIC_REL.replaceAll('|', ','),
			COUNTIES,
			'E_TABLE_HEADER'
		],
		[
			'a relationship row with an empty county GEOID',
			BASIC_ZCTA,
			rel(part('21046', '', '500')),
			COUNTIES,
			'E_TABLE_LINE'
		],
		[
			'a relationship row with a 4-digit county GEOID',
			BASIC_ZCTA,
			rel(part('21046', '2400', '500')),
			COUNTIES,
			'E_TABLE_LINE'
		],
		[
			'a relationship row with a 4-digit ZCTA',
			BASIC_ZCTA,
			rel(part('2104', '24001', '500')),
			COUNTIES,
			'E_TABLE_LINE'
		],
		[
			'a relationship land area that is not a number',
			BASIC_ZCTA,
			rel(part('21046', '24001', 'lots')),
			COUNTIES,
			'E_TABLE_LINE'
		],
		[
			'a relationship line with a field missing',
			BASIC_ZCTA,
			rel(part('21046', '24001', '500').split('|').slice(1).join('|')),
			COUNTIES,
			'E_TABLE_LINE'
		],
		[
			'a counties header without GEOID',
			BASIC_ZCTA,
			BASIC_REL,
			COUNTIES.replace('|GEOID|', '|FIPS|'),
			'E_TABLE_HEADER'
		],
		[
			'a counties file with commas for delimiters',
			BASIC_ZCTA,
			BASIC_REL,
			COUNTIES.replaceAll('|', ','),
			'E_TABLE_HEADER'
		],
		[
			'a county GEOID that is not 5 digits',
			BASIC_ZCTA,
			BASIC_REL,
			counties(county('MD', '2400')),
			'E_TABLE_LINE'
		],
		[
			'two state codes for one state FIPS',
			BASIC_ZCTA,
			BASIC_REL,
			counties(county('MD', '24001'), county('VA', '24510')),
			'E_TABLE_LINE'
		]
	])('refuses %s', (_name, zcta, relationship, list, code) => {
		expect(failure(() => zipsFromGazetteer(zcta, relationship, list))).toBe(code);
	});
});

const FULL_HEADER = [
	'SVC',
	'MPC',
	'MOC',
	'MOC_TITLE',
	'OLD_DODOCC',
	'OLD_DODMED',
	'DODOCC',
	'DODOCC_TITLE',
	'STATUS',
	'SDATE',
	'EDATE',
	'CHANGE_TYPE',
	'XDATE',
	'SOC1',
	'SOC2',
	'SOC3',
	'SOC4',
	'SOC1_TITLE',
	'SOC2_TITLE',
	'SOC3_TITLE',
	'SOC4_TITLE',
	'MOTD1',
	'MOTD1_TITLE',
	'MOTD2',
	'MOTD2_TITLE',
	'ONET1',
	'ONET2',
	'ONET3',
	'ONET4',
	'ONET1_TITLE',
	'ONET2_TITLE',
	'ONET3_TITLE',
	'ONET4_TITLE',
	'record_changed'
];

type XRow = Partial<Record<(typeof FULL_HEADER)[number], string>>;

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

/** A CSV in the O*NET file's layout: every field quoted, empty ones left bare, as the real file does. */
function xwalk(rows: XRow[], newline = '\n', header = FULL_HEADER): string {
	const base: XRow = {
		SVC: 'A',
		MPC: 'E',
		MOC: '11B',
		MOC_TITLE: 'Infantryman',
		STATUS: 'A',
		ONET1: '33-3051.00',
		ONET1_TITLE: 'Police and Patrol Officers'
	};
	const lines = rows.map((row) => {
		const merged = { ...base, ...row };
		return header
			.map((name) => {
				const value = merged[name] ?? '';
				return value === '' ? '' : quote(value);
			})
			.join(',');
	});
	return [header.map(quote).join(','), ...lines].join(newline) + newline;
}

describe('crosswalkFromCsv', () => {
	it('parses quoted commas, doubled quotes and a line break inside a quoted field', () => {
		const { table } = crosswalkFromCsv(
			xwalk([
				{
					MOC_TITLE: 'Infantry,\nrifle "squad"',
					ONET1_TITLE: 'Officers, "Special" Units'
				}
			])
		);
		expect(table.rows).toEqual([['11B', 'Army', '33-3051.00', 'Officers, "Special" Units']]);
	});

	it('reads Windows line ends the same as Unix ones', () => {
		const rows = [{ MOC: '11B' }, { MOC: '12B', ONET1: '47-2061.00' }];
		expect(crosswalkFromCsv(xwalk(rows, '\r\n'))).toEqual(crosswalkFromCsv(xwalk(rows)));
	});

	it.each([
		['A', 'Army'],
		['J', 'Army'],
		['Q', 'Army'],
		['C', 'Coast Guard'],
		['F', 'Air Force'],
		['X', 'Air Force'],
		['Y', 'Air Force'],
		['Z', 'Air Force'],
		['H', 'Space Force'],
		['L', 'Space Force'],
		['O', 'Space Force'],
		['U', 'Space Force'],
		['M', 'Marine Corps'],
		['N', 'Navy'],
		['P', 'Navy'],
		['S', 'Navy'],
		['V', 'Navy']
	])('files service letter %s under %s', (SVC, branch) => {
		const { table } = crosswalkFromCsv(xwalk([{ SVC }]));
		expect(table.rows).toEqual([['11B', branch, '33-3051.00', 'Police and Patrol Officers']]);
	});

	it('refuses a service letter it does not know rather than dropping the row', () => {
		expect(failure(() => crosswalkFromCsv(xwalk([{ SVC: 'B' }])))).toBe('E_TABLE_LINE');
	});

	it('keeps only active rows', () => {
		const { table } = crosswalkFromCsv(
			xwalk([
				{ MOC: '11B', STATUS: 'A' },
				{ MOC: '12B', STATUS: 'O' },
				{ MOC: '13B', STATUS: '1' },
				{ MOC: '14B', STATUS: '2' }
			])
		);
		expect(table.rows.map((row) => row[0])).toEqual(['11B']);
	});

	it('skips civilian rows, whether by service letter or by pay class, and counts them', () => {
		const { table, skipped } = crosswalkFromCsv(
			xwalk([
				{ MOC: '11B' },
				{ MOC: '0301', SVC: 'G', MPC: '-' },
				{ MOC: '0302', SVC: 'D' },
				{ MOC: '0303', SVC: 'K' },
				{ MOC: '0304', MPC: '-' }
			])
		);
		expect(table.rows.map((row) => row[0])).toEqual(['11B']);
		expect(skipped).toEqual({ NOT_MILITARY: 3, CIVILIAN: 1 });
	});

	it('trims a military code, and skips one that is not code-shaped, with a count', () => {
		const { table, skipped } = crosswalkFromCsv(
			xwalk([{ MOC: '11B ' }, { MOC: 'AB(CDE)' }, { MOC: '12a ' }, { MOC: 'TOOLONG7' }])
		);
		expect(table.rows.map((row) => row[0])).toEqual(['11B']);
		expect(skipped).toEqual({ MOC_SHAPE: 3 });
	});

	it('skips a pair with a malformed O*NET code or an unsafe or long title, and counts each', () => {
		const { table, skipped } = crosswalkFromCsv(
			xwalk([
				{
					MOC: '11B',
					ONET1: '33-3051',
					ONET2: '33-3051.00',
					ONET2_TITLE: 'Fine title',
					ONET3: '47-2061.00',
					ONET3_TITLE: 'Title with <markup>',
					ONET4: '47-2062.00',
					ONET4_TITLE: 'x'.repeat(151)
				}
			])
		);
		expect(table.rows).toEqual([['11B', 'Army', '33-3051.00', 'Fine title']]);
		expect(skipped).toEqual({ ONET_SHAPE: 3 });
	});

	// The listing text gate refuses all three; a title that skips it would reach the table the app reads.
	it('skips a title with a line separator, only a combining mark, or stacked marks', () => {
		const { table, skipped } = crosswalkFromCsv(
			xwalk([
				{
					ONET2: '47-2061.00',
					ONET2_TITLE: 'Welders' + String.fromCharCode(0x2028) + 'Cutters',
					ONET3: '47-2062.00',
					ONET3_TITLE: String.fromCharCode(0x301, 0x301),
					ONET4: '47-2063.00',
					ONET4_TITLE: 'Welders' + String.fromCharCode(0x489, 0x489, 0x489)
				}
			])
		);
		expect(table.rows).toEqual([['11B', 'Army', '33-3051.00', 'Police and Patrol Officers']]);
		expect(skipped).toEqual({ ONET_SHAPE: 3 });
	});

	it('gives a row with four O*NET pairs four rows', () => {
		const { table } = crosswalkFromCsv(
			xwalk([
				{
					ONET1: '11-1011.00',
					ONET1_TITLE: 'One',
					ONET2: '22-1011.00',
					ONET2_TITLE: 'Two',
					ONET3: '33-1011.00',
					ONET3_TITLE: 'Three',
					ONET4: '44-1011.00',
					ONET4_TITLE: 'Four'
				}
			])
		);
		expect(table.rows.map((row) => row[2])).toEqual([
			'11-1011.00',
			'22-1011.00',
			'33-1011.00',
			'44-1011.00'
		]);
	});

	it('drops repeats and sorts by code, then branch, then O*NET code', () => {
		const { table } = crosswalkFromCsv(
			xwalk([
				{ MOC: '2A6X1', SVC: 'F', ONET1: '49-3011.00' },
				{ MOC: '11B', SVC: 'M' },
				{ MOC: '11B', SVC: 'A', ONET1: '33-3051.00' },
				{ MOC: '11B', SVC: 'A', ONET1: '33-3051.00' },
				{ MOC: '11B', SVC: 'A', ONET1: '11-1011.00' }
			])
		);
		expect(table.rows.map((row) => row.slice(0, 3))).toEqual([
			['11B', 'Army', '11-1011.00'],
			['11B', 'Army', '33-3051.00'],
			['11B', 'Marine Corps', '33-3051.00'],
			['2A6X1', 'Air Force', '49-3011.00']
		]);
		expect(validateCrosswalk(table)).toEqual({ valid: true, errors: [] });
	});

	it('finds columns by name, whatever their order', () => {
		const reordered = [...FULL_HEADER].reverse();
		expect(crosswalkFromCsv(xwalk([{ MOC: '11B' }], '\n', reordered))).toEqual(
			crosswalkFromCsv(xwalk([{ MOC: '11B' }]))
		);
	});

	it.each([
		[
			'a header without ONET3_TITLE',
			xwalk(
				[{}],
				'\n',
				FULL_HEADER.filter((name) => name !== 'ONET3_TITLE')
			),
			'E_TABLE_HEADER'
		],
		['a row with a field missing', xwalk([{}]).trimEnd() + '\n"A","E"\n', 'E_TABLE_LINE'],
		['a quote never closed', xwalk([{}]) + '"A","E","11B\n', 'E_TABLE_LINE'],
		[
			'text after a closing quote',
			xwalk([{}]).replace('"Infantryman"', '"Infantry"man'),
			'E_TABLE_LINE'
		]
	])('refuses %s', (_name, text, code) => {
		expect(failure(() => crosswalkFromCsv(text))).toBe(code);
	});
});

describe('stateExtentsFromCounties', () => {
	const HEADER =
		'USPS|GEOID|GEOIDFQ|ANSICODE|NAME|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG';
	const county = (usps: string, aland: string, awater: string, lat: string, lon: string) =>
		`${usps}|00000|0500000US00000|0|Example County|${aland}|${awater}|0|0|${lat}|${lon}`;
	const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';

	// Two counties of one state, worked by hand from the rule. A county's pad is twice the radius of a circle of
	// its own area: area pi * (10 km)^2 gives radius 10 km, so padLat = 2 * 10 / 111.32 = 0.17966 degrees and,
	// at latitude 39.0034, padLon = 20 / (111.32 * cos 39.0034 deg) = 0.23119. Area pi * (20 km)^2 gives radius
	// 20 km: padLat = 0.35932, and at latitude 38.0063 padLon = 40 / (111.32 * cos 38.0063 deg) = 0.45603.
	//   south  = 38.0063 - 0.35932 = 37.64698   west  = -77.0    - 0.23119 = -77.23119
	//   north  = 39.0034 + 0.17966 = 39.18306   east  = -75.994  + 0.45603 = -75.53797
	// The state box is their union widened by 0.1 on every side: [37.54698, -77.33119, 39.28306, -75.43797],
	// then rounded outward to two decimals (south and west down, north and east up), which is what separates it
	// from plain rounding on all four edges.
	const TWO_COUNTIES = file(
		county('MD', '300000000', '14159265', '39.0034', '-77.0'),
		county('MD', '1256637061', '0', '38.0063', '-75.994')
	);

	it('pads each county, joins them, widens by 0.1 and rounds outward', () => {
		expect(stateExtentsFromCounties(TWO_COUNTIES)).toEqual({ MD: [37.54, -77.34, 39.29, -75.43] });
	});

	it('gives each state its own box and covers territories with counties', () => {
		const extents = stateExtentsFromCounties(
			file(
				county('MD', '300000000', '0', '39.0', '-77.0'),
				county('PR', '300000000', '0', '18.2', '-66.5')
			)
		);
		expect(Object.keys(extents).sort()).toEqual(['MD', 'PR']);
		const pr = extents.PR as StateExtent;
		expect(pr[0]).toBeLessThan(18.2);
		expect(pr[2]).toBeGreaterThan(18.2);
	});

	it('ignores a county of a code that is not a state', () => {
		const extents = stateExtentsFromCounties(
			file(
				county('MD', '300000000', '0', '39.0', '-77.0'),
				county('ZZ', '300000000', '0', '10.0', '10.0')
			)
		);
		expect(Object.keys(extents)).toEqual(['MD']);
	});

	// The Census file writes the longitude of a county east of Greenwich with a leading plus sign.
	it('reads a longitude written with a leading plus sign', () => {
		const plain = file(county('AK', '300000000', '0', '51.9', '179.6'));
		const signed = file(county('AK', '300000000', '0', '51.9', '+179.6'));
		expect(stateExtentsFromCounties(signed)).toEqual(stateExtentsFromCounties(plain));
	});

	// Every area lies west of Greenwich except the western Aleutians, whose interior point is past 180 degrees
	// west and so is written as a positive longitude. Read as written, it would stretch Alaska's box east across
	// Asia and Europe; read as the same place west of Greenwich, the box stays over North America.
	it('does not let a county written east of Greenwich stretch a box across the world', () => {
		const extents = stateExtentsFromCounties(
			file(
				county('AK', '300000000', '0', '61.2', '-149.9'),
				county('AK', '300000000', '0', '51.9', '+179.6')
			)
		);
		const alaska = extents.AK as StateExtent;
		expect(alaska[1]).toBe(-180);
		expect(alaska[3]).toBeLessThan(-140);
		expect(alaska[3]).toBeGreaterThan(-149.9);
	});

	it('clamps a box to the globe', () => {
		const extents = stateExtentsFromCounties(
			file(
				county('AK', '10000000000', '0', '89.95', '179.99'),
				county('HI', '10000000000', '0', '-89.95', '-179.99')
			)
		);
		expect(extents.AK?.[2]).toBe(90);
		expect(extents.AK?.[3]).toBe(180);
		expect(extents.HI?.[0]).toBe(-90);
		expect(extents.HI?.[1]).toBe(-180);
	});

	it.each([
		[
			'a line with a field missing',
			file('MD|00000|x|0|Example County|1|1|0|0|39.0'),
			'E_TABLE_LINE'
		],
		[
			'an area that is not a number',
			file(county('MD', 'lots', '0', '39.0', '-77.0')),
			'E_TABLE_LINE'
		],
		[
			'a latitude that is not a number',
			file(county('MD', '300000000', '0', 'north', '-77.0')),
			'E_TABLE_LINE'
		],
		['a header without AWATER', HEADER.replace('AWATER|', '') + '\n', 'E_TABLE_HEADER']
	])('refuses %s', (_name, text, code) => {
		expect(failure(() => stateExtentsFromCounties(text))).toBe(code);
	});
});

describe('stateExtentsSource', () => {
	const extents: Partial<Record<StateCode, StateExtent>> = {
		VA: [36.5, -83.7, 39.5, -75.2],
		MD: [37.54, -77.34, 39.29, -75.43]
	};
	const source = stateExtentsSource(extents, 'Example counties gazetteer');
	const folders: string[] = [];
	afterEach(() => {
		for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
	});

	it('writes the module the app imports, naming its source and its generator', () => {
		expect(source).toContain('export const STATE_EXTENTS');
		expect(source).toContain('Example counties gazetteer');
		expect(source).toContain('content-ops/skillbridge/tables.mjs');
	});

	it('writes states in the contract order, whatever order they were given', () => {
		expect(source.indexOf('MD:')).toBeGreaterThan(0);
		expect(source.indexOf('MD:')).toBeLessThan(source.indexOf('VA:'));
		expect(
			stateExtentsSource({ MD: extents.MD as StateExtent, VA: extents.VA as StateExtent }, 'x')
		).toBe(
			stateExtentsSource({ VA: extents.VA as StateExtent, MD: extents.MD as StateExtent }, 'x')
		);
	});

	it('is a module that compiles and answers the questions it is for', async () => {
		const compiled = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
			reportDiagnostics: true
		});
		expect(compiled.diagnostics ?? []).toEqual([]);
		const folder = mkdtempSync(join(tmpdir(), 'extents-'));
		folders.push(folder);
		const file = join(folder, 'state-extents.mjs');
		writeFileSync(file, compiled.outputText);
		const loaded = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
			STATE_EXTENTS: unknown;
			isInStateExtent: (code: string, la: number, lo: number) => boolean | undefined;
		};
		expect(loaded.STATE_EXTENTS).toEqual(extents);
		expect(loaded.isInStateExtent('MD', 39.2, -76.86)).toBe(true);
		expect(loaded.isInStateExtent('MD', 37.54, -77.34)).toBe(true);
		expect(loaded.isInStateExtent('MD', 39.2, 76.86)).toBe(false);
		expect(loaded.isInStateExtent('GU', 13.47, 144.75)).toBeUndefined();
	});

	it('is already in the repo formatting, so regenerating never leaves a diff', async () => {
		const path = fileURLToPath(
			new URL('../../src/lib/skillbridge-finder/contract/state-extents.ts', import.meta.url)
		);
		const options = (await prettier.resolveConfig(path)) ?? {};
		expect(await prettier.format(source, { ...options, filepath: path })).toBe(source);
	});
});

describe('isInsideFolder', () => {
	it('tells a path in the folder, or the folder itself, from one beside or above it', () => {
		const root = join(tmpdir(), 'repo-root');
		expect(isInsideFolder(root, join(root, 'out'))).toBe(true);
		expect(isInsideFolder(root, root)).toBe(true);
		expect(isInsideFolder(root, join(root, 'a', '..', 'b', 'c'))).toBe(true);
		expect(isInsideFolder(root, join(tmpdir(), 'repo-root-copy', 'out'))).toBe(false);
		expect(isInsideFolder(root, tmpdir())).toBe(false);
		expect(isInsideFolder(root, join(root, '..', 'elsewhere'))).toBe(false);
	});

	it('resolves real paths with the operating system call by default', () => {
		expect(DEFAULT_REALPATH).toBe(realpathSync.native);
	});

	// The skillbridge state holds raw rows with contact names, so it must never land in the repo; a string compare
	// of two paths misses every spelling below, which the file system opens as the same folder.
	const BACKSLASH = String.fromCharCode(92);
	const folders: string[] = [];
	afterEach(() => {
		for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
	});

	/** A temp folder holding a `repo` folder; the folder is removed after the test. */
	function repoInTemp(): { temp: string; repo: string } {
		const temp = mkdtempSync(join(tmpdir(), 'inside-'));
		folders.push(temp);
		const repo = join(temp, 'repo');
		mkdirSync(repo);
		return { temp, repo };
	}

	it('follows a link into the folder, and tells a sibling folder from the folder', () => {
		const { temp, repo } = repoInTemp();
		symlinkSync(repo, join(temp, 'link'), 'junction');
		expect(isInsideFolder(repo, join(temp, 'link', 'state'))).toBe(true);
		expect(isInsideFolder(repo, join(temp, 'link'))).toBe(true);
		mkdirSync(join(temp, 'sibling'));
		expect(isInsideFolder(repo, join(temp, 'sibling', 'state'))).toBe(false);
		expect(isInsideFolder(repo, join(temp, 'repo-two', 'state'))).toBe(false);
	});

	it('asks the injected resolver about the deepest folder that exists and keeps the rest as written', () => {
		const root = join(tmpdir(), 'repo-root');
		const real = new Map([
			[join(tmpdir(), 'linked'), root],
			[tmpdir(), tmpdir()]
		]);
		const resolver = (path: string) => {
			const found = real.get(path);
			if (found === undefined) throw new Error('E_TEST_MISSING');
			return found;
		};
		expect(isInsideFolder(root, join(tmpdir(), 'linked', 'a', 'state'), resolver)).toBe(true);
		expect(isInsideFolder(root, join(tmpdir(), 'other', 'state'), resolver)).toBe(false);
	});

	// These spellings are Windows ones; elsewhere a backslash is an ordinary letter of a file name.
	describe.runIf(process.platform === 'win32')('Windows spellings of a folder in the repo', () => {
		it.each([
			['the verbatim form', (repo: string) => BACKSLASH.repeat(2) + '?' + BACKSLASH + repo],
			['a folder name ending in a dot', (repo: string) => repo + '.'],
			['a folder name ending in a space', (repo: string) => repo + ' '],
			['another case', (repo: string) => repo.toUpperCase()],
			[
				'the administrative share of the same drive',
				(repo: string) =>
					BACKSLASH.repeat(2) + 'localhost' + BACKSLASH + repo.slice(0, 1) + '$' + repo.slice(2)
			]
		])('refuses %s', (_what, spell) => {
			const { temp, repo } = repoInTemp();
			// The spelled folder does not exist as written, so only a real path comparison can see it is the repo.
			mkdirSync(join(temp, 'repo', 'state'));
			const target = spell(repo) + BACKSLASH + 'state';
			expect(isInsideFolder(repo, target)).toBe(true);
		});

		it.each([
			[
				'a network path',
				BACKSLASH.repeat(2) + 'server' + BACKSLASH + 'share' + BACKSLASH + 'state'
			],
			['a device path', BACKSLASH.repeat(2) + '.' + BACKSLASH + 'C:' + BACKSLASH + 'state'],
			['a network path with slashes', '//server/share/state']
		])('refuses %s, which cannot be checked', (_what, target) => {
			const { repo } = repoInTemp();
			expect(isInsideFolder(repo, target)).toBe(true);
		});

		it('does not take a folder that only starts like the repo for the repo', () => {
			const { temp, repo } = repoInTemp();
			mkdirSync(join(temp, 'repo.two'));
			expect(isInsideFolder(repo, join(temp, 'repo.two', 'state'))).toBe(false);
			expect(
				isInsideFolder(repo, BACKSLASH.repeat(2) + '?' + BACKSLASH + join(temp, 'repo.two'))
			).toBe(false);
		});
	});
});
