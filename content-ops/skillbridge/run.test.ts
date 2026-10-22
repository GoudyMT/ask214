import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, runPipeline } from './run.mjs';
import { API_ORIGIN, FILTERS_PATH, LOOKUP_PATH, ROBOTS_PATH } from './config.ts';
import { checkTree } from './guard-core.ts';
import type { GuardDeps, TreeEntry } from './guard-core.ts';
import type { LinkDeps } from './links-core.ts';
import type { Clock, Http, HttpReply } from './pull-core.ts';
import type { PipelineState } from './types.ts';
import type { ApiListing } from '../../src/lib/skillbridge-finder/contract/api.ts';
import type { ChangesFile } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import { rawListing } from '../../src/lib/skillbridge-finder/fixtures/raw.ts';
import { validateRegionFile } from '../../src/lib/skillbridge-finder/contract/validate.ts';

// The one command, run end to end against a fake server and a temp folder: what Max runs each week, with
// nothing on the network and never the real deploy folder.

const FIRST = '2026-10-21';
const SECOND = '2026-10-28';
const THIRD = '2026-11-04';
const ONE = 'Example Provider One';
const TWO = 'Example Provider Two';
const CAP = 150;
const ALL_URL = `${API_ORIGIN}${LOOKUP_PATH}?draw=1&start=0&length=${CAP}`;

type World = { providers: [string, ApiListing[]][]; scripts: Map<string, HttpReply[]> };

const json = (body: unknown): HttpReply => ({
	status: 200,
	contentType: 'application/json; charset=utf-8',
	body: JSON.stringify(body)
});

/** A clean in-person listing; each differs in its program so none is taken for a copy of another. */
function row(id: number, over: Partial<ApiListing> = {}): ApiListing {
	return rawListing({
		id,
		program: `Example Program ${id}`,
		programId: 500 + id,
		...over
	});
}

const rowsOf = (ids: number[], over: Partial<ApiListing> = {}) => ids.map((id) => row(id, over));

function makeWorld(over: Partial<World> = {}): World {
	return {
		providers: [
			[ONE, rowsOf([1, 2, 3, 4, 5])],
			[TWO, rowsOf([6, 7, 8])]
		],
		scripts: new Map(),
		...over
	};
}

function answer(world: World, url: string): HttpReply {
	const total = world.providers.reduce((n, [, rows]) => n + rows.length, 0);
	if (url === API_ORIGIN + ROBOTS_PATH) return { status: 404, contentType: 'text/plain', body: '' };
	if (url === API_ORIGIN + FILTERS_PATH)
		return json({
			providers: world.providers.map(([name]) => name),
			states: ['MD'],
			industries: [],
			branches: [],
			meta: { totalPositions: String(total) },
			dib: false
		});
	const u = new URL(url);
	const provider = u.searchParams.get('provider');
	const pool =
		provider === null
			? world.providers.flatMap(([, rows]) => rows)
			: (world.providers.find(([name]) => name === provider) ?? ['', []])[1];
	return json({
		draw: 1,
		recordsTotal: provider === null && u.searchParams.size === 3 ? total : pool.length,
		recordsFiltered: Math.min(pool.length, CAP),
		data: pool.slice(0, CAP)
	});
}

function fakeHttp(world: World) {
	const urls: string[] = [];
	const http: Http = (url) => {
		urls.push(url);
		return Promise.resolve(world.scripts.get(url)?.shift() ?? answer(world, url));
	};
	return { http, urls };
}

function fakeClock(): Clock {
	let t = 1_000_000;
	return {
		now: () => t,
		sleep: (ms) => {
			t += ms;
			return Promise.resolve();
		}
	};
}

/** Link deps that record every call and confirm nothing. */
function linkSpy() {
	const calls: string[] = [];
	const deps: LinkDeps = {
		wikidata: () => {
			calls.push('wikidata');
			return Promise.resolve(new Map());
		},
		siteCheck: (url) => {
			calls.push(url);
			return Promise.resolve(false);
		}
	};
	return { deps, calls };
}

let temp = '';
afterEach(() => {
	if (temp !== '') rmSync(temp, { recursive: true });
	temp = '';
});

/** A state folder, a deploy folder and a stand-in for the repo, all under one temp folder removed afterwards. */
function folders(name = 'run') {
	if (temp === '') temp = mkdtempSync(join(tmpdir(), 'sbk-run-'));
	const base = join(temp, name);
	const repoRoot = join(base, 'repo');
	mkdirSync(repoRoot, { recursive: true });
	return {
		repoRoot,
		stateDir: join(base, 'state'),
		deployDir: join(base, 'deploy')
	};
}

type Where = ReturnType<typeof folders>;
type Options = Parameters<typeof runPipeline>[0];

function options(where: Where, over: Partial<Options> = {}): Options {
	return {
		stateDir: where.stateDir,
		deployDir: where.deployDir,
		mode: 'auto',
		baseline: false,
		acceptDrift: false,
		noLinks: false,
		fromSnapshot: null,
		...over
	};
}

/** One run of the command against a world, on a given day. */
async function go(
	where: Where,
	world: World,
	today: string,
	over: Partial<Options> = {},
	spy = linkSpy()
) {
	const server = fakeHttp(world);
	const printed: string[] = [];
	const result = await runPipeline(options(where, over), {
		http: server.http,
		clock: fakeClock(),
		linkDeps: spy.deps,
		today: () => today,
		repoRoot: where.repoRoot,
		print: (line) => {
			printed.push(line);
		}
	});
	return { result, urls: server.urls, spy, printed };
}

function listFiles(dir: string, rel = ''): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(rel === '' ? dir : join(dir, rel)).flatMap((name) => {
		const path = rel === '' ? name : `${rel}/${name}`;
		return lstatSync(join(dir, path)).isDirectory() ? listFiles(dir, path) : [path];
	});
}

/** Every file under a folder with a hash of its bytes: two equal maps mean nothing changed. */
function hashTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const path of listFiles(dir).sort())
		out[path] = createHash('sha256')
			.update(readFileSync(join(dir, ...path.split('/'))))
			.digest('hex');
	return out;
}

function guardDeps(): GuardDeps {
	const walk = (dir: string, rel = ''): TreeEntry[] =>
		readdirSync(rel === '' ? dir : join(dir, rel)).flatMap((name) => {
			const path = rel === '' ? name : `${rel}/${name}`;
			const stat = lstatSync(join(dir, path));
			const entry: TreeEntry = {
				path,
				bytes: stat.size,
				isFile: stat.isFile(),
				isSymlink: stat.isSymbolicLink()
			};
			return stat.isDirectory() ? [entry, ...walk(dir, path)] : [entry];
		});
	return {
		repoRoot: 'C:/not-used',
		readText: (path) => readFileSync(path, 'utf8'),
		listTree: (dir) => walk(dir),
		runner: () => Promise.resolve(0),
		wranglerJs: '',
		nodePath: '',
		cwd: '',
		env: {}
	};
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const stateOf = (where: Where) => readJson(join(where.stateDir, 'state.json')) as PipelineState;
const weekDir = (where: Where, date: string) =>
	join(where.deployDir, 'skillbridge-data', 'w', date);

describe('the first full run', () => {
	it('writes a deploy tree the guard accepts, with every region file valid, and saves the state', async () => {
		const where = folders();
		const { result } = await go(where, makeWorld(), FIRST, { baseline: true });

		expect(result.exitCode).toBe(0);
		expect(checkTree(where.deployDir, guardDeps())).toEqual([]);
		const index = readJson(join(where.deployDir, 'skillbridge-data', 'index.json')) as {
			pullDate: string;
			baseline: boolean;
		};
		expect(index).toMatchObject({ pullDate: FIRST, baseline: true });
		for (const name of readdirSync(weekDir(where, FIRST))) {
			if (name === 'ids.json' || name === 'changes.json') continue;
			const file = readJson(join(weekDir(where, FIRST), name));
			expect(validateRegionFile(file).errors, name).toEqual([]);
		}
		expect(stateOf(where)).toMatchObject({ lastPullDate: FIRST, baselineDate: FIRST });
		expect(result.report).toMatchObject({ published: 8, added: 0, removed: 0, baseline: true });
		expect(existsSync(join(where.stateDir, 'runs', FIRST, 'raw.json'))).toBe(true);
		expect(existsSync(join(where.stateDir, 'runs', FIRST, 'report.txt'))).toBe(true);
	});
});

describe('a second week', () => {
	it('publishes what changed, removes only what its complete provider no longer lists, and keeps two weeks', async () => {
		const where = folders();
		await go(where, makeWorld(), FIRST, { baseline: true });
		const next = makeWorld({
			providers: [
				[ONE, [...rowsOf([1, 2, 3, 4]), row(9, { dateCreated: '2026-10-20T00:00:00' })]],
				[TWO, rowsOf([6, 7, 8])]
			]
		});
		const { result } = await go(where, next, SECOND);

		expect(result.exitCode).toBe(0);
		const changes = readJson(join(weekDir(where, SECOND), 'changes.json')) as ChangesFile;
		expect(changes.weeks.map((w) => w.pullDate)).toEqual([SECOND, FIRST]);
		expect(changes.weeks[0]).toMatchObject({ added: [9], removed: [5] });
		expect(readdirSync(join(where.deployDir, 'skillbridge-data', 'w')).sort()).toEqual([
			FIRST,
			SECOND
		]);
		expect(checkTree(where.deployDir, guardDeps())).toEqual([]);
	});

	it('keeps only the newest two saved runs and never touches a folder that is not a date', async () => {
		const where = folders();
		await go(where, makeWorld(), FIRST, { baseline: true });
		mkdirSync(join(where.stateDir, 'runs', 'notes'));
		await go(where, makeWorld(), SECOND);
		await go(where, makeWorld(), THIRD);
		expect(readdirSync(join(where.stateDir, 'runs')).sort()).toEqual([SECOND, THIRD, 'notes']);
	});

	// The pull asks the server for every provider it is given, so an empty name would be asked for as itself.
	it('does not ask for a provider with no name', async () => {
		const where = folders();
		await go(where, makeWorld(), FIRST, { baseline: true });
		const state = stateOf(where);
		const first = state.records['1'];
		if (first === undefined) throw new Error('E_TEST_NO_RECORD');
		first.provider = '';
		writeFileSync(join(where.stateDir, 'state.json'), JSON.stringify(state));

		const { urls } = await go(where, makeWorld(), SECOND);
		expect(urls.filter((u) => /provider=(&|$)/.test(u))).toEqual([]);
	});
});

describe('an address removed on request', () => {
	const PAT = 'pat@example.com';
	const withPat = () =>
		makeWorld({
			providers: [
				[ONE, [row(1, { employerPocEmail: PAT }), ...rowsOf([2, 3, 4, 5])]],
				[TWO, rowsOf([6, 7, 8])]
			]
		});

	/** Every file under a folder whose text holds the address, ignoring case. */
	function filesHolding(dir: string, address: string): string[] {
		return listFiles(dir).filter((path) =>
			readFileSync(join(dir, ...path.split('/')), 'utf8')
				.toLowerCase()
				.includes(address)
		);
	}

	function suppress(where: Where, entries: string[]) {
		const state = stateOf(where);
		state.suppression = entries;
		writeFileSync(join(where.stateDir, 'state.json'), JSON.stringify(state));
	}

	it('is gone from every file of the deploy folder the next week, last week included, whatever its case or spacing', async () => {
		const where = folders();
		await go(where, withPat(), FIRST, { baseline: true });
		expect(filesHolding(where.deployDir, PAT).length).toBeGreaterThan(0);

		suppress(where, ['  PAT@example.com ']);
		const { result } = await go(where, withPat(), SECOND);

		expect(result.exitCode).toBe(0);
		expect(filesHolding(where.deployDir, PAT)).toEqual([]);
		expect(readdirSync(join(where.deployDir, 'skillbridge-data', 'w'))).toEqual([SECOND]);
		expect(checkTree(where.deployDir, guardDeps())).toEqual([]);
	});

	it('leaves last week deployed when the list holds only addresses nobody published', async () => {
		const where = folders();
		await go(where, withPat(), FIRST, { baseline: true });

		suppress(where, ['nobody@example.com']);
		await go(where, withPat(), SECOND);

		expect(readdirSync(join(where.deployDir, 'skillbridge-data', 'w')).sort()).toEqual([
			FIRST,
			SECOND
		]);
	});
});

describe('a run that cannot be trusted writes nothing to the deploy tree', () => {
	it('stops when the server says no, leaving the tree and the state exactly as they were', async () => {
		const where = folders();
		await go(where, makeWorld(), FIRST, { baseline: true });
		const treeBefore = hashTree(where.deployDir);
		const stateBefore = readFileSync(join(where.stateDir, 'state.json'), 'utf8');

		const world = makeWorld();
		world.scripts.set(`${ALL_URL}&provider=${encodeURIComponent(ONE)}`, [
			{ status: 429, contentType: 'text/plain', body: '' }
		]);
		const { result } = await go(where, world, SECOND);

		expect(result.exitCode).toBe(2);
		expect(result.report?.stop).toBe('E_HTTP_429');
		expect(hashTree(where.deployDir)).toEqual(treeBefore);
		expect(readFileSync(join(where.stateDir, 'state.json'), 'utf8')).toBe(stateBefore);
		expect(readFileSync(join(where.stateDir, 'runs', SECOND, 'report.txt'), 'utf8')).toContain(
			'E_HTTP_429'
		);
	});

	// The tree is written before the state is saved, so a save that failed leaves a week deployed that the state
	// never heard of; a run on that state would date everything again and mark the old listings New.
	it('refuses to run on a saved state that is older than the deploy tree, before any request', async () => {
		const where = folders();
		await go(where, makeWorld(), FIRST, { baseline: true });
		const weekOneState = readFileSync(join(where.stateDir, 'state.json'), 'utf8');
		await go(where, makeWorld(), SECOND);
		writeFileSync(join(where.stateDir, 'state.json'), weekOneState);
		const treeBefore = hashTree(where.deployDir);

		const { result, urls, printed } = await go(where, makeWorld(), THIRD);

		expect(result.exitCode).toBe(3);
		expect(printed).toContain('E_STATE_BEHIND_DEPLOY');
		expect(urls).toEqual([]);
		expect(hashTree(where.deployDir)).toEqual(treeBefore);
		expect(readFileSync(join(where.stateDir, 'state.json'), 'utf8')).toBe(weekOneState);
		expect(existsSync(join(where.stateDir, 'runs', THIRD))).toBe(false);
	});

	// The pull takes hours, and a saved run is overwritten or pruned after it, so the date is judged before it starts.
	it.each([
		['the same day as the last run', FIRST, FIRST],
		['a day before the last run', SECOND, '2026-10-24']
	])('refuses a run dated %s before any request, touching nothing', async (_name, last, today) => {
		const where = folders();
		await go(where, makeWorld(), FIRST, { baseline: true });
		if (last !== FIRST) await go(where, makeWorld(), last);
		const runsBefore = hashTree(join(where.stateDir, 'runs'));
		const treeBefore = hashTree(where.deployDir);
		const stateBefore = readFileSync(join(where.stateDir, 'state.json'), 'utf8');

		const { result, urls, printed } = await go(where, makeWorld(), today);

		expect(result.exitCode).toBe(3);
		expect(printed).toContain('E_PULL_DATE_ORDER');
		expect(urls).toEqual([]);
		expect(hashTree(join(where.stateDir, 'runs'))).toEqual(runsBefore);
		expect(hashTree(where.deployDir)).toEqual(treeBefore);
		expect(readFileSync(join(where.stateDir, 'state.json'), 'utf8')).toBe(stateBefore);
	});

	it('is blocked by a drift past 20%, leaving the tree and the state as they were, until Max accepts it', async () => {
		const where = folders();
		await go(where, makeWorld(), FIRST, { baseline: true });
		const treeBefore = hashTree(where.deployDir);
		const stateBefore = readFileSync(join(where.stateDir, 'state.json'), 'utf8');

		const surge = makeWorld({
			providers: [
				[ONE, rowsOf([1, 2, 3, 4, 5, 20, 21, 22, 23, 24])],
				[TWO, rowsOf([6, 7, 8])]
			]
		});
		const blocked = await go(where, surge, SECOND);
		expect(blocked.result.exitCode).toBe(3);
		expect(blocked.result.report?.blockers).toContain('E_DRIFT');
		expect(hashTree(where.deployDir)).toEqual(treeBefore);
		expect(readFileSync(join(where.stateDir, 'state.json'), 'utf8')).toBe(stateBefore);
		expect(readFileSync(join(where.stateDir, 'runs', SECOND, 'report.txt'), 'utf8')).toContain(
			'E_DRIFT'
		);

		const accepted = await go(where, surge, SECOND, { acceptDrift: true });
		expect(accepted.result.exitCode).toBe(0);
		expect(existsSync(weekDir(where, SECOND))).toBe(true);
	});
});

describe('company links', () => {
	it('makes no request with --no-links, yet a pinned site from the state still shows', async () => {
		const where = folders();
		mkdirSync(where.stateDir);
		const seeded: PipelineState = {
			v: 1,
			baselineDate: null,
			lastPullDate: null,
			records: {},
			knownOrgs: [],
			knownProviders: [],
			providerCounts: [],
			pinnedSites: [[301, 'https://example.com/']],
			suppression: [],
			lastWeek: null,
			nextMode: 'full'
		};
		writeFileSync(join(where.stateDir, 'state.json'), JSON.stringify(seeded));

		const quiet = await go(where, makeWorld(), FIRST, { baseline: true, noLinks: true });
		expect(quiet.result.exitCode).toBe(0);
		expect(quiet.spy.calls).toEqual([]);
		const region = readJson(join(weekDir(where, FIRST), 'south-atlantic.json')) as {
			listings: { w?: string }[];
		};
		expect(region.listings.length).toBeGreaterThan(0);
		expect(region.listings.every((l) => l.w === 'https://example.com/')).toBe(true);

		// The spy is live: the same run with links on does ask.
		const other = folders('other');
		const loud = await go(other, makeWorld(), FIRST, { baseline: true });
		expect(loud.spy.calls.length).toBeGreaterThan(0);
	});
});

describe('--from-snapshot', () => {
	function snapshot(rows: ApiListing[]): string {
		const dir = join(temp, 'run', 'snapshot');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'filters.json'),
			JSON.stringify({
				providers: [ONE],
				states: ['MD'],
				industries: [],
				branches: [],
				meta: { totalPositions: String(rows.length) }
			})
		);
		writeFileSync(join(dir, 'listings.json'), JSON.stringify(rows));
		return dir;
	}

	it('publishes a baseline from saved rows without any request, and later removes nothing', async () => {
		const where = folders();
		const rows = rowsOf([1, 2, 3]);
		const first = await go(where, makeWorld(), FIRST, {
			baseline: true,
			fromSnapshot: snapshot([...rows, row(3)])
		});
		expect(first.urls).toEqual([]);
		expect(first.result.exitCode).toBe(0);
		expect(first.result.report).toMatchObject({ published: 3, uniqueIds: 3, baseline: true });

		const second = await go(where, makeWorld(), SECOND, {
			fromSnapshot: snapshot(rows.slice(0, 2))
		});
		expect(second.urls).toEqual([]);
		expect(second.result.exitCode).toBe(0);
		expect(second.result.report).toMatchObject({ published: 3, removed: 0, notSeen: 1 });
	});
});

describe('bad arguments and bad files', () => {
	it('refuses a state folder inside the repo and creates nothing', async () => {
		const where = folders();
		const inside = join(where.repoRoot, 'state');
		const { result, urls } = await go(where, makeWorld(), FIRST, {
			stateDir: inside,
			baseline: true
		});
		expect(result.exitCode).toBe(1);
		expect(result.report).toBeNull();
		expect(existsSync(inside)).toBe(false);
		expect(urls).toEqual([]);
		expect(existsSync(where.deployDir)).toBe(false);
	});

	it('refuses an unreadable state file and leaves it as it was', async () => {
		const where = folders();
		mkdirSync(where.stateDir);
		writeFileSync(join(where.stateDir, 'state.json'), '{ not json');
		const { result, urls } = await go(where, makeWorld(), FIRST, { baseline: true });
		expect(result.exitCode).toBe(1);
		expect(readFileSync(join(where.stateDir, 'state.json'), 'utf8')).toBe('{ not json');
		expect(urls).toEqual([]);
		expect(existsSync(where.deployDir)).toBe(false);
	});

	it('refuses a table that breaks its contract', async () => {
		const where = folders();
		mkdirSync(join(where.stateDir, 'tables'), { recursive: true });
		writeFileSync(
			join(where.stateDir, 'tables', 'zips.json'),
			JSON.stringify({ v: 1, rows: [['2104', 39.2, -76.86]] })
		);
		const { result } = await go(where, makeWorld(), FIRST, { baseline: true });
		expect(result.exitCode).toBe(1);
		expect(existsSync(where.deployDir)).toBe(false);
	});

	it('refuses a pull date that is not a date, which would build folder names', async () => {
		const where = folders();
		const { result } = await go(where, makeWorld(), '../escape', { baseline: true });
		expect(result.exitCode).toBe(1);
		expect(existsSync(join(where.stateDir, 'escape'))).toBe(false);
		expect(existsSync(join(where.stateDir, 'runs'))).toBe(false);
		expect(existsSync(where.deployDir)).toBe(false);
	});
});

describe('the command line', () => {
	function cliDeps(where: Where) {
		const server = fakeHttp(makeWorld());
		const printed: string[] = [];
		return {
			printed,
			urls: server.urls,
			deps: {
				http: server.http,
				clock: fakeClock(),
				linkDeps: linkSpy().deps,
				today: () => FIRST,
				repoRoot: where.repoRoot,
				print: (line: string) => {
					printed.push(line);
				}
			}
		};
	}

	it('prints the usage and exits 0 for --help, without reading or writing anything', async () => {
		const where = folders();
		const { deps, printed, urls } = cliDeps(where);
		expect(await runCli(['--help'], deps)).toBe(0);
		expect(printed.join('\n')).toContain('--state');
		expect(urls).toEqual([]);
		expect(existsSync(where.stateDir)).toBe(false);
	});

	it.each([
		['an unknown flag', ['--bogus']],
		['no state folder', ['--baseline']],
		['a mode that is not one of the three', ['--state', 'x', '--mode', 'sometimes']]
	])('shows the usage and exits 1 for %s', async (_name, argv) => {
		const where = folders();
		const { deps, printed } = cliDeps(where);
		expect(await runCli(argv, deps)).toBe(1);
		expect(printed.join('\n')).toContain('--state');
	});

	it('deploys to the data Worker deploy folder of the repo unless told otherwise', async () => {
		const where = folders();
		const { deps } = cliDeps(where);
		const code = await runCli(['--state', where.stateDir, '--baseline', '--no-links'], deps);
		expect(code).toBe(0);
		expect(
			existsSync(
				join(
					where.repoRoot,
					'workers',
					'skillbridge-data',
					'deploy',
					'skillbridge-data',
					'index.json'
				)
			)
		).toBe(true);
	});

	it('uses the --deploy folder and the --mode it is given', async () => {
		const where = folders();
		const { deps } = cliDeps(where);
		const code = await runCli(
			['--state', where.stateDir, '--deploy', where.deployDir, '--mode', 'full', '--baseline'],
			deps
		);
		expect(code).toBe(0);
		expect(existsSync(join(where.deployDir, 'skillbridge-data', 'index.json'))).toBe(true);
	});
});
