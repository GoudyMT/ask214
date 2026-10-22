import { describe, it, expect } from 'vitest';
import {
	DIVISION_OF_STATE,
	DIVISIONS,
	REGION_FILE_NAMES,
	STATE_CODES,
	TABLE_FILE_NAMES,
	TERRITORY_CODES,
	dataPath,
	isRegionFileName
} from './places';

describe('the division map', () => {
	it('puts every state and DC in exactly one division and every territory in none', () => {
		const mapped = Object.keys(DIVISION_OF_STATE);
		expect(new Set(mapped).size).toBe(51);
		expect([...mapped].sort()).toEqual(
			STATE_CODES.filter((c) => !TERRITORY_CODES.includes(c)).sort()
		);
		for (const code of TERRITORY_CODES) expect(DIVISION_OF_STATE[code]).toBeUndefined();
		for (const division of Object.values(DIVISION_OF_STATE)) expect(DIVISIONS).toContain(division);
	});

	// census.gov "Geographic Levels" (economic-census guidance) is the source for these placements; the
	// rows are the ones a person is most likely to be wrong about.
	it.each([
		['DC', 'south-atlantic'],
		['DE', 'south-atlantic'],
		['AK', 'pacific'],
		['HI', 'pacific'],
		['MO', 'west-north-central'],
		['OK', 'west-south-central'],
		['KY', 'east-south-central'],
		['NM', 'mountain'],
		['PA', 'middle-atlantic'],
		['MI', 'east-north-central'],
		['VT', 'new-england']
	])('places %s in %s', (code, division) => {
		expect(DIVISION_OF_STATE[code as keyof typeof DIVISION_OF_STATE]).toBe(division);
	});

	it('holds the nine Census division sizes', () => {
		const sizes = DIVISIONS.map(
			(d) => Object.values(DIVISION_OF_STATE).filter((v) => v === d).length
		);
		expect(sizes).toEqual([6, 3, 5, 7, 9, 4, 4, 8, 5]);
	});
});

describe('the file names a client may ask for', () => {
	it('allows the nine divisions and the five fixed files, nothing else', () => {
		expect(REGION_FILE_NAMES).toEqual([
			...DIVISIONS,
			'multi-state',
			'remote',
			'territories',
			'overseas',
			'unknown'
		]);
		for (const name of REGION_FILE_NAMES) expect(isRegionFileName(name)).toBe(true);
	});

	it.each(['texas', 'TX', 'pacific.json', '../index', 'w/2026-10-21/pacific', '', 'constructor'])(
		'refuses the off-list name %j',
		(name) => {
			expect(isRegionFileName(name)).toBe(false);
		}
	);

	it('builds every path from fixed parts and a checked pull date', () => {
		expect(dataPath({ kind: 'index' })).toBe('/skillbridge-data/index.json');
		expect(dataPath({ kind: 'region', pullDate: '2026-10-21', name: 'pacific' })).toBe(
			'/skillbridge-data/w/2026-10-21/pacific.json'
		);
		expect(dataPath({ kind: 'ids', pullDate: '2026-10-21' })).toBe(
			'/skillbridge-data/w/2026-10-21/ids.json'
		);
		expect(dataPath({ kind: 'changes', pullDate: '2026-10-21' })).toBe(
			'/skillbridge-data/w/2026-10-21/changes.json'
		);
		for (const name of TABLE_FILE_NAMES)
			expect(dataPath({ kind: 'table', name })).toBe(`/skillbridge-data/tables/${name}.json`);
	});

	// A path is the only thing that leaves the device, so a value that is not a fixed name or a real date
	// (a ZIP, a place, a query) must never become one.
	it.each([
		[{ kind: 'region', pullDate: '2026-10-21', name: '90210' }],
		[{ kind: 'region', pullDate: '2026-10-21?zip=90210', name: 'pacific' }],
		[{ kind: 'ids', pullDate: '2026-13-01' }],
		[{ kind: 'changes', pullDate: '../2026-10-21' }],
		[{ kind: 'table', name: 'zips?near=90210' }]
	])('throws on %j', (input) => {
		expect(() => dataPath(input as Parameters<typeof dataPath>[0])).toThrow('E_SBF_BAD_PATH');
	});
});
