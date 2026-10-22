import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	assertDirectChild,
	buildWeek,
	nodeTreeFs,
	placeListing,
	writeDeployTree
} from './layout-core.ts';
import type { BuiltWeek, TreeFs } from './layout-core.ts';
import { DATA_HEADERS_FILE } from './config.ts';
import type { Listing } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import {
	MAX_FILE_BYTES,
	MAX_LISTINGS_PER_FILE
} from '../../src/lib/skillbridge-finder/contract/listing.ts';
import {
	REGION_FILE_NAMES,
	STATE_CODES,
	TERRITORY_CODES,
	dataPath
} from '../../src/lib/skillbridge-finder/contract/places.ts';
import type { StateCode } from '../../src/lib/skillbridge-finder/contract/places.ts';
import {
	validateChanges,
	validateIds,
	validateIndex,
	validateRegionFile
} from '../../src/lib/skillbridge-finder/contract/validate.ts';
import {
	validateCrosswalk,
	validateZips
} from '../../src/lib/skillbridge-finder/contract/tables.ts';

const PULL_DATE = '2026-10-21';
const BASELINE = '2026-01-05';
const NO_OVERSEAS: ReadonlySet<number> = new Set();

function listing(i: number, over: Partial<Listing> = {}): Listing {
	return {
		i,
		o: 301,
		n: 'Example Wind Services',
		p: 'Field Technician Internship',
		s: 'MD',
		m: 1,
		b: [],
		ind: ['Management'],
		dib: false,
		dc: '2026-02-10',
		fl: BASELINE,
		...over
	};
}

/** A listing that names no state (remote, or no usable place). */
function placeless(i: number, over: Partial<Listing> = {}): Listing {
	const l = listing(i, over);
	delete l.s;
	return l;
}

const NON_TERRITORY = STATE_CODES.filter((c) => !TERRITORY_CODES.includes(c));

describe('placeListing: every listing goes to its files and nowhere else', () => {
	it.each([
		['an MD listing', listing(1), ['south-atlantic']],
		[
			'a TX listing that also names MD and VA',
			listing(1, { s: 'TX', ls: ['MD', 'VA'] }),
			['south-atlantic', 'west-south-central']
		],
		[
			'9 states over 4 divisions',
			listing(1, { s: 'MD', ls: ['MD', 'VA', 'TX', 'OK', 'CA', 'WA', 'NY', 'NJ', 'PA'] }),
			['middle-atlantic', 'south-atlantic', 'west-south-central', 'pacific']
		],
		[
			'10 states, in none of their divisions',
			listing(1, { ls: ['MD', 'VA', 'TX', 'OK', 'CA', 'WA', 'NY', 'NJ', 'PA', 'FL'] }),
			['multi-state']
		],
		['all 51 states', listing(1, { ls: NON_TERRITORY as StateCode[] }), ['multi-state']],
		['a remote listing that names a state', listing(1, { m: 2, s: 'MD', ls: ['MD'] }), ['remote']],
		['a Puerto Rico listing', listing(1, { s: 'PR' }), ['territories']],
		[
			'an MD listing that also names PR',
			listing(1, { ls: ['MD', 'PR'] }),
			['south-atlantic', 'territories']
		]
	] satisfies [string, Listing, string[]][])('%s', (_name, l, files) => {
		expect(placeListing(l, NO_OVERSEAS)).toEqual(files);
	});

	it('puts an overseas id in the overseas file only', () => {
		expect(placeListing(listing(7), new Set([7]))).toEqual(['overseas']);
	});

	it('puts a listing with no usable place in unknown', () => {
		expect(placeListing(placeless(1), NO_OVERSEAS)).toEqual(['unknown']);
	});
});

const TABLES = {
	zips: { v: 1, rows: [['21046', 39.2, -76.86]] },
	crosswalk: { v: 1, rows: [['91B', 'Army', '49-3023.00', 'Automotive Service Technicians']] }
};

function input(
	over: Partial<Parameters<typeof buildWeek>[0]> = {}
): Parameters<typeof buildWeek>[0] {
	return {
		pullDate: PULL_DATE,
		baseline: false,
		baselineDate: BASELINE,
		published: [
			listing(1),
			listing(2, { s: 'TX', ls: ['MD', 'VA'], fl: '2026-10-07' }),
			placeless(3, { m: 2 }),
			listing(4, { s: 'PR' }),
			placeless(5),
			listing(6, { ls: ['MD', 'VA', 'TX', 'OK', 'CA', 'WA', 'NY', 'NJ', 'PA', 'FL'] })
		],
		overseas: NO_OVERSEAS,
		aliases: [],
		weeks: [
			{ pullDate: PULL_DATE, added: [2], removed: [], newOrgs: [] },
			{ pullDate: '2026-10-14', added: [], removed: [9], newOrgs: [] }
		],
		tables: {},
		...over
	};
}

const bodyOf = (week: BuiltWeek, path: string): string => {
	const file = week.files.find((f) => f.path === path);
	expect(file, `file ${path}`).toBeDefined();
	return file?.body ?? '';
};
const regionPath = (name: (typeof REGION_FILE_NAMES)[number]) =>
	dataPath({ kind: 'region', pullDate: PULL_DATE, name }).slice(1);

describe('buildWeek', () => {
	it('writes exactly the paths the guard allows, each of them valid for its own contract', () => {
		const week = buildWeek(input({ tables: TABLES }));
		expect(week.errors).toEqual([]);
		const regions = REGION_FILE_NAMES.filter((n) => n !== 'overseas').map(regionPath);
		expect(week.files.map((f) => f.path).sort()).toEqual(
			[
				'_headers',
				'skillbridge-data/index.json',
				`skillbridge-data/w/${PULL_DATE}/ids.json`,
				`skillbridge-data/w/${PULL_DATE}/changes.json`,
				'skillbridge-data/tables/zips.json',
				'skillbridge-data/tables/crosswalk.json',
				...regions
			].sort()
		);
		for (const { path, body } of week.files) {
			if (path === '_headers') continue;
			const parsed: unknown = JSON.parse(body);
			const result = path.endsWith('/index.json')
				? validateIndex(parsed)
				: path.endsWith('/ids.json')
					? validateIds(parsed)
					: path.endsWith('/changes.json')
						? validateChanges(parsed)
						: path.endsWith('/zips.json')
							? validateZips(parsed)
							: path.endsWith('/crosswalk.json')
								? validateCrosswalk(parsed)
								: validateRegionFile(parsed);
			expect(result.errors, path).toEqual([]);
		}
	});

	// Distance is by ZIP only, so no table of bases is published even when a caller hands one in.
	it('never writes a bases table', () => {
		const tables: Record<string, unknown> = {
			...TABLES,
			bases: { v: 1, rows: [['Example Base', 'MD', 39.1, -76.7]] }
		};
		const week = buildWeek(input({ tables }));
		expect(week.errors).toEqual([]);
		expect(week.files.filter((f) => f.path.includes('bases'))).toEqual([]);
		expect(week.files.some((f) => f.path.endsWith('/zips.json'))).toBe(true);
	});

	it('files each listing under every region it belongs to and no other, sorted by id', () => {
		const week = buildWeek(input());
		const idsIn = (name: (typeof REGION_FILE_NAMES)[number]) =>
			(JSON.parse(bodyOf(week, regionPath(name))) as { listings: Listing[] }).listings.map(
				(l) => l.i
			);
		expect(idsIn('south-atlantic')).toEqual([1, 2]);
		expect(idsIn('west-south-central')).toEqual([2]);
		expect(idsIn('multi-state')).toEqual([6]);
		expect(idsIn('remote')).toEqual([3]);
		expect(idsIn('territories')).toEqual([4]);
		expect(idsIn('unknown')).toEqual([5]);
		expect(idsIn('pacific')).toEqual([]);
	});

	it('lists each region file in index.json with its real count and byte length', () => {
		const week = buildWeek(input());
		const names = week.index.files.map((f) => f.name);
		expect(names).toEqual(REGION_FILE_NAMES.filter((n) => n !== 'overseas'));
		for (const f of week.index.files) {
			const body = bodyOf(week, regionPath(f.name));
			expect(f.bytes).toBe(Buffer.byteLength(body, 'utf8'));
			expect(f.count).toBe((JSON.parse(body) as { listings: unknown[] }).listings.length);
		}
		expect(JSON.parse(bodyOf(week, 'skillbridge-data/index.json'))).toEqual(week.index);
		expect(week.index).toMatchObject({ v: 1, pullDate: PULL_DATE, baseline: false });
	});

	it('counts the bytes of non-ASCII text as UTF-8, not as characters', () => {
		const accented = 'Caf' + String.fromCharCode(0xe9) + ' Services';
		const week = buildWeek(input({ published: [listing(1, { n: accented })] }));
		const f = week.index.files.find((x) => x.name === 'south-atlantic');
		expect(f?.bytes).toBe(Buffer.byteLength(bodyOf(week, regionPath('south-atlantic')), 'utf8'));
		expect(f?.bytes).toBeGreaterThan(bodyOf(week, regionPath('south-atlantic')).length);
	});

	it('adds overseas.json only when a listing is overseas', () => {
		expect(buildWeek(input()).files.some((f) => f.path === regionPath('overseas'))).toBe(false);
		const withOverseas = buildWeek(input({ overseas: new Set([5]) }));
		const body = JSON.parse(bodyOf(withOverseas, regionPath('overseas'))) as {
			listings: Listing[];
		};
		expect(body.listings.map((l) => l.i)).toEqual([5]);
		expect(withOverseas.index.files.map((f) => f.name)).toContain('overseas');
		expect(withOverseas.errors).toEqual([]);
	});

	it('carries every id with its first-listed date, and only aliases that point at a published id', () => {
		const week = buildWeek(
			input({
				aliases: [
					[9, 2],
					[8, 999],
					[1, 2],
					[7, 1]
				]
			})
		);
		const ids = JSON.parse(bodyOf(week, `skillbridge-data/w/${PULL_DATE}/ids.json`)) as {
			ids: [number, string][];
			aliases: [number, number][];
		};
		expect(ids.ids).toEqual([
			[1, BASELINE],
			[2, '2026-10-07'],
			[3, BASELINE],
			[4, BASELINE],
			[5, BASELINE],
			[6, BASELINE]
		]);
		expect(ids.aliases).toEqual([
			[7, 1],
			[9, 2]
		]);
	});

	it('publishes this week then last week, newest first, and no more than two', () => {
		const three = [
			...input().weeks,
			{ pullDate: '2026-10-07', added: [], removed: [], newOrgs: [] }
		];
		const week = buildWeek(input({ weeks: three }));
		const changes = JSON.parse(bodyOf(week, `skillbridge-data/w/${PULL_DATE}/changes.json`)) as {
			weeks: { pullDate: string }[];
		};
		expect(changes.weeks.map((w) => w.pullDate)).toEqual([PULL_DATE, '2026-10-14']);
	});

	it('refuses weeks given oldest first', () => {
		const week = buildWeek(input({ weeks: [...input().weeks].reverse() }));
		expect(week.errors).toEqual(['E_INVALID_CHANGES']);
	});

	it('refuses a region file past the listing cap', () => {
		const many = Array.from({ length: MAX_LISTINGS_PER_FILE + 1 }, (_, k) => listing(k + 1));
		const week = buildWeek(input({ published: many }));
		expect(week.errors).toContain('E_TOO_MANY_LISTINGS');
	});

	it('refuses a file past the byte cap', () => {
		// Twenty role names of about 40 characters each is about 1 KB a listing: 14,000 of them pass 10 MB.
		const roles = Array.from({ length: 20 }, () => 'Alpha Bravo Charlie Delta Echo Foxtrot');
		const fat = Array.from({ length: 14_000 }, (_, k) => listing(k + 1, { r: roles }));
		const week = buildWeek(input({ published: fat }));
		expect(Buffer.byteLength(bodyOf(week, regionPath('south-atlantic')), 'utf8')).toBeGreaterThan(
			MAX_FILE_BYTES
		);
		expect(week.errors).toContain('E_FILE_TOO_BIG');
	});

	it('refuses a listing that breaks the contract', () => {
		const week = buildWeek(input({ published: [listing(1, { n: 'Example <b>Markup</b>' })] }));
		expect(week.errors).toEqual(['E_INVALID_REGION']);
	});

	it('refuses the same id published twice', () => {
		const week = buildWeek(input({ published: [listing(1), listing(1)] }));
		expect(week.errors).toContain('E_INVALID_IDS');
	});

	it('refuses a table that breaks the contract', () => {
		const week = buildWeek(input({ tables: { zips: { v: 1, rows: [['2104', 39.2, -76.86]] } } }));
		expect(week.errors).toEqual(['E_INVALID_TABLE']);
	});

	it('refuses an index whose baseline date is after the pull date', () => {
		const week = buildWeek(input({ baselineDate: '2026-11-01' }));
		expect(week.errors).toEqual(['E_INVALID_INDEX']);
	});

	it('refuses a pull date or baseline date that is not a date, and builds nothing', () => {
		for (const over of [{ pullDate: '2026-02-30' }, { baselineDate: 'later' }]) {
			const week = buildWeek(input(over));
			expect(week.errors).toEqual(['E_BAD_DATE']);
			expect(week.files).toEqual([]);
		}
	});

	it('serves every file with the data Worker headers', () => {
		const headers = bodyOf(buildWeek(input()), '_headers');
		expect(headers).toBe(DATA_HEADERS_FILE);
		expect(headers).toContain('no-store');
	});
});

/** A deploy folder in memory that refuses what a real disk refuses: no parent, or a rename over a folder. */
function memoryFs() {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const calls: string[] = [];
	const under = (p: string) => (q: string) => q.startsWith(p + '/');
	const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
	const fs: TreeFs = {
		exists: (p) => files.has(p) || dirs.has(p),
		mkdir(p) {
			calls.push(`mkdir ${p}`);
			for (let d = p; d.includes('/'); d = parentOf(d)) dirs.add(d);
			dirs.add(p);
		},
		writeFile(p, body) {
			calls.push(`write ${p}`);
			if (!dirs.has(parentOf(p))) throw new Error('E_TEST_NO_PARENT');
			files.set(p, body);
		},
		rename(from, to) {
			calls.push(`rename ${from} -> ${to}`);
			if (dirs.has(to)) throw new Error('E_TEST_RENAME_OVER_FOLDER');
			if (files.has(from)) {
				files.set(to, files.get(from) as string);
				files.delete(from);
				return;
			}
			if (!dirs.has(from)) throw new Error('E_TEST_NO_SOURCE');
			for (const d of [...dirs]) {
				if (d === from || under(from)(d)) {
					dirs.delete(d);
					dirs.add(to + d.slice(from.length));
				}
			}
			for (const [f, body] of [...files]) {
				if (under(from)(f)) {
					files.delete(f);
					files.set(to + f.slice(from.length), body);
				}
			}
		},
		listDir(p) {
			const names = new Set<string>();
			for (const q of [...files.keys(), ...dirs]) {
				if (under(p)(q) && !q.slice(p.length + 1).includes('/')) names.add(q.slice(p.length + 1));
			}
			return [...names];
		},
		isDirectory: (p) => dirs.has(p),
		removeDir(p) {
			calls.push(`remove ${p}`);
			if (!dirs.has(p)) throw new Error('E_TEST_NO_FOLDER');
			for (const d of [...dirs]) if (d === p || under(p)(d)) dirs.delete(d);
			for (const f of [...files.keys()]) if (under(p)(f)) files.delete(f);
		}
	};
	return { fs, files, dirs, calls };
}

const ROOT = 'C:/deploy-test';
const W = `${ROOT}/skillbridge-data/w`;

function weekFor(pullDate: string, over: Partial<Parameters<typeof buildWeek>[0]> = {}): BuiltWeek {
	const built = buildWeek(
		input({
			pullDate,
			weeks: [{ pullDate, added: [], removed: [], newOrgs: [] }],
			...over
		})
	);
	if (built.errors.length > 0) throw new Error('E_TEST_BAD_WEEK');
	return built;
}

describe('writeDeployTree', () => {
	it('writes index.json last, through a temporary file, and prunes only after that', () => {
		const mem = memoryFs();
		for (const date of ['2026-10-07', '2026-10-14']) writeDeployTree(ROOT, weekFor(date), mem.fs);
		mem.calls.length = 0;
		writeDeployTree(ROOT, weekFor(PULL_DATE, { tables: TABLES }), mem.fs);

		const writes = mem.calls.filter((c) => c.startsWith('write '));
		expect(writes[0]).toBe(`write ${ROOT}/_headers`);
		expect(writes.at(-1)).toBe(`write ${ROOT}/skillbridge-data/index.json.tmp`);
		expect(writes.filter((c) => c.includes('index.json'))).toHaveLength(1);

		const swap = mem.calls.indexOf(
			`rename ${ROOT}/skillbridge-data/index.json.tmp -> ${ROOT}/skillbridge-data/index.json`
		);
		const lastWrite = mem.calls.lastIndexOf(writes.at(-1) as string);
		const lastOtherRename = mem.calls.findLastIndex(
			(c) => c.startsWith('rename ') && !c.includes('index.json')
		);
		const firstRemoveOfOldWeek = mem.calls.findIndex((c) => c === `remove ${W}/2026-10-07`);
		expect(swap).toBe(lastWrite + 1);
		expect(lastOtherRename).toBeLessThan(lastWrite);
		expect(firstRemoveOfOldWeek).toBeGreaterThan(swap);
	});

	// The pull date builds the folder paths that get removed, so a value that is not a date (a hand-built or
	// damaged week) must never reach them: such a value points the removal at the whole data folder.
	it.each([['..'], ['2026-10-21/..'], ['../../x']])(
		'refuses a pull date of %s before touching anything',
		(bad) => {
			const mem = memoryFs();
			writeDeployTree(ROOT, weekFor(PULL_DATE), mem.fs);
			mem.calls.length = 0;
			const good = weekFor(PULL_DATE);
			const forged: BuiltWeek = { ...good, index: { ...good.index, pullDate: bad } };
			expect(() => writeDeployTree(ROOT, forged, mem.fs)).toThrow('E_BAD_DATE');
			expect(mem.calls).toEqual([]);
			expect(mem.fs.exists(`${W}/${PULL_DATE}`)).toBe(true);
		}
	);

	it('writes nothing when the week has errors', () => {
		const mem = memoryFs();
		const bad = buildWeek(input({ published: [listing(1, { n: 'Example <b>Markup</b>' })] }));
		expect(() => writeDeployTree(ROOT, bad, mem.fs)).toThrow('E_WEEK_HAS_ERRORS');
		expect(mem.calls).toEqual([]);
	});

	it('keeps this week and last week, and removes the older ones', () => {
		const mem = memoryFs();
		let last = { pruned: [] as string[], kept: [] as string[], ignored: [] as string[] };
		for (const date of ['2026-10-07', '2026-10-14', PULL_DATE])
			last = writeDeployTree(ROOT, weekFor(date), mem.fs);
		expect(mem.fs.listDir(W).sort()).toEqual(['2026-10-14', PULL_DATE]);
		expect(last).toEqual({ pruned: ['2026-10-07'], kept: ['2026-10-14', PULL_DATE], ignored: [] });
	});

	it('keeps only the folder it just wrote when asked, and still leaves a name that is not a date', () => {
		const mem = memoryFs();
		writeDeployTree(ROOT, weekFor('2026-10-07'), mem.fs);
		writeDeployTree(ROOT, weekFor('2026-10-14'), mem.fs);
		mem.fs.mkdir(`${W}/notes`);
		const out = writeDeployTree(ROOT, weekFor(PULL_DATE), mem.fs, { onlyThisWeek: true });
		expect(out).toEqual({
			pruned: ['2026-10-07', '2026-10-14'],
			kept: [PULL_DATE],
			ignored: ['notes']
		});
		expect(mem.fs.listDir(W).sort()).toEqual([PULL_DATE, 'notes']);
	});

	it('never removes an entry that is not a dated folder, and names it back', () => {
		const mem = memoryFs();
		writeDeployTree(ROOT, weekFor('2026-10-07'), mem.fs);
		mem.fs.mkdir(`${W}/notes`);
		mem.fs.mkdir(`${W}/2026-09-01.tmp`);
		mem.fs.writeFile(`${W}/readme.txt`, 'x');
		writeDeployTree(ROOT, weekFor('2026-10-14'), mem.fs);
		const out = writeDeployTree(ROOT, weekFor(PULL_DATE), mem.fs);
		expect(out.pruned).toEqual(['2026-10-07']);
		expect(out.ignored).toEqual(['2026-09-01.tmp', 'notes', 'readme.txt']);
		expect(mem.fs.listDir(W).sort()).toEqual([
			'2026-09-01.tmp',
			'2026-10-14',
			PULL_DATE,
			'notes',
			'readme.txt'
		]);
	});

	it('replaces a folder for the same pull date whole, leaving no stale file in it', () => {
		const mem = memoryFs();
		writeDeployTree(ROOT, weekFor(PULL_DATE, { overseas: new Set([5]) }), mem.fs);
		expect(mem.files.has(`${W}/${PULL_DATE}/overseas.json`)).toBe(true);
		writeDeployTree(ROOT, weekFor(PULL_DATE), mem.fs);
		expect(mem.files.has(`${W}/${PULL_DATE}/overseas.json`)).toBe(false);
		expect(mem.files.has(`${W}/${PULL_DATE}/ids.json`)).toBe(true);
		expect(mem.fs.listDir(W)).toEqual([PULL_DATE]);
	});

	// A run that died after writing some of its temporary folder must not leak those files into the next one.
	it('starts a leftover temporary folder of its own pull date afresh', () => {
		const mem = memoryFs();
		mem.fs.mkdir(`${W}/${PULL_DATE}.tmp`);
		mem.fs.writeFile(`${W}/${PULL_DATE}.tmp/stale.json`, 'x');
		writeDeployTree(ROOT, weekFor(PULL_DATE), mem.fs);
		expect(mem.fs.listDir(W)).toEqual([PULL_DATE]);
		expect(mem.files.has(`${W}/${PULL_DATE}/stale.json`)).toBe(false);
	});

	// index.json points at the folder just written, so pruning must never take that one.
	it('keeps the folder it just wrote even when it is older than the others', () => {
		const mem = memoryFs();
		writeDeployTree(ROOT, weekFor('2026-10-14'), mem.fs);
		writeDeployTree(ROOT, weekFor(PULL_DATE), mem.fs);
		const out = writeDeployTree(ROOT, weekFor('2026-10-07'), mem.fs);
		expect(mem.fs.listDir(W)).toContain('2026-10-07');
		expect(out.pruned).toEqual(['2026-10-14']);
	});
});

describe('assertDirectChild: what the prune may remove', () => {
	it('accepts a dated folder directly in the weeks folder', () => {
		expect(() => assertDirectChild(W, `${W}/2026-10-07`)).not.toThrow();
	});

	// A prune that reached a temporary twin would take a half-written week with it; only a date passes.
	it.each([
		['a temporary folder', `${W}/2026-10-07.tmp`],
		['a name that is not a date', `${W}/notes`],
		['a nested path', `${W}/2026-10-07/ids.json`],
		['the weeks folder itself', W],
		['a path climbing out', `${W}/../2026-10-07`],
		['a folder elsewhere', `${ROOT}/2026-10-07`]
	])('refuses %s', (_name, path) => {
		expect(() => assertDirectChild(W, path)).toThrow('E_UNSAFE_PRUNE');
	});
});

describe('writeDeployTree on a real folder', () => {
	let temp = '';
	afterEach(() => {
		if (temp !== '') rmSync(temp, { recursive: true });
		temp = '';
	});

	it('swaps in each week, replaces index.json, and prunes with real removals', () => {
		temp = mkdtempSync(join(tmpdir(), 'sbk-layout-'));
		const w = join(temp, 'skillbridge-data', 'w');
		for (const date of ['2026-10-07', '2026-10-14'])
			writeDeployTree(temp, weekFor(date), nodeTreeFs);
		mkdirSync(join(w, 'notes'));
		const out = writeDeployTree(temp, weekFor(PULL_DATE, { tables: TABLES }), nodeTreeFs);

		expect(out).toEqual({
			pruned: ['2026-10-07'],
			kept: ['2026-10-14', PULL_DATE],
			ignored: ['notes']
		});
		expect(readdirSync(w).sort()).toEqual(['2026-10-14', PULL_DATE, 'notes']);
		const index = JSON.parse(
			readFileSync(join(temp, 'skillbridge-data', 'index.json'), 'utf8')
		) as {
			pullDate: string;
		};
		expect(index.pullDate).toBe(PULL_DATE);
		expect(existsSync(join(temp, 'skillbridge-data', 'index.json.tmp'))).toBe(false);
		expect(readFileSync(join(temp, '_headers'), 'utf8')).toBe(DATA_HEADERS_FILE);
		expect(existsSync(join(temp, 'skillbridge-data', 'tables', 'zips.json'))).toBe(true);
		expect(readdirSync(join(w, PULL_DATE)).sort()).toEqual(
			[
				...REGION_FILE_NAMES.filter((n) => n !== 'overseas').map((n) => `${n}.json`),
				'changes.json',
				'ids.json'
			].sort()
		);
	});
});
