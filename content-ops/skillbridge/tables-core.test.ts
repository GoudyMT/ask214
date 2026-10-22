import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
	crosswalkFromCsv,
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

	it('gives one rounded row per ZIP, sorted, in a table the app accepts', () => {
		const table = zipsFromGazetteer(
			file(
				line('21046', '39.18921', '-76.86012'),
				line('00601', '18.180621', '-66.749931'),
				line('02134', '42.3551', '-71.1304')
			)
		);
		expect(table).toEqual({
			v: 1,
			rows: [
				['00601', 18.181, -66.75],
				['02134', 42.355, -71.13],
				['21046', 39.189, -76.86]
			]
		});
		expect(validateZips(table)).toEqual({ valid: true, errors: [] });
	});

	it('reads Windows line ends the same as Unix ones', () => {
		const unix = file(line('21046', '39.18921', '-76.86012'), line('00601', '18.18', '-66.75'));
		expect(zipsFromGazetteer(unix.replaceAll('\n', '\r\n'))).toEqual(zipsFromGazetteer(unix));
	});

	it('finds columns by name, whatever their order', () => {
		const shuffled = 'INTPTLONG|X|GEOID|INTPTLAT\n-76.86012|a|21046|39.18921\n';
		expect(zipsFromGazetteer(shuffled).rows).toEqual([['21046', 39.189, -76.86]]);
	});

	it.each([
		['a 4-digit GEOID', file(line('1046', '39.1', '-76.8')), 'E_TABLE_LINE'],
		['a letter in a GEOID', file(line('2104a', '39.1', '-76.8')), 'E_TABLE_LINE'],
		['a line with 7 fields', file('21046|860Z200US21046|1|2|3|39.1|-76.8'), 'E_TABLE_LINE'],
		['a latitude that is not a number', file(line('21046', 'north', '-76.8')), 'E_TABLE_LINE'],
		['an empty longitude', file(line('21046', '39.1', '')), 'E_TABLE_LINE'],
		[
			'a repeated GEOID',
			file(line('21046', '39.1', '-76.8'), line('21046', '39.2', '-76.9')),
			'E_TABLE_LINE'
		],
		[
			'a blank line between rows',
			file(line('21046', '39.1', '-76.8'), '', line('21047', '39.1', '-76.8')),
			'E_TABLE_LINE'
		],
		['a latitude past the poles', file(line('21046', '95.1', '-76.8')), 'E_TABLE_INVALID'],
		['a header without INTPTLONG', HEADER.replace('INTPTLONG', 'LONG') + '\n', 'E_TABLE_HEADER'],
		['no header at all', '', 'E_TABLE_HEADER']
	])('refuses %s', (_name, text, code) => {
		expect(failure(() => zipsFromGazetteer(text))).toBe(code);
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
});
