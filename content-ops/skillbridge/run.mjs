/**
 * The weekly SkillBridge data run, as one command. It pulls the public listings gently (or reads a saved snapshot),
 * cleans them to facts, confirms company links, checks the week, writes the static deploy tree and a report. When
 * anything is wrong it writes nothing to the deploy tree and does not save the state, so the week already deployed
 * stays exactly as it was.
 *
 *   node --import tsx content-ops/skillbridge/run.mjs --state <folder> [options]
 *
 * Exit codes: 0 written, 1 bad arguments or files, 2 the pull stopped, 3 blocked (nothing written).
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIsoDate } from '../../src/lib/skillbridge-finder/contract/places.ts';
import { STATE_EXTENTS } from '../../src/lib/skillbridge-finder/contract/state-extents.ts';
import {
	validateCrosswalk,
	validateZips
} from '../../src/lib/skillbridge-finder/contract/tables.ts';
import { emptyState, runCheck } from './check-core.ts';
import { cleanListings } from './clean-core.ts';
import { assertDirectChild, buildWeek, nodeTreeFs, writeDeployTree } from './layout-core.ts';
import { runLinks } from './links-core.ts';
import { runPull } from './pull-core.ts';
import { createHttp, realClock } from './pull.ts';
import { buildReport, reportText } from './report-core.ts';
import { createSiteCheck } from './site-check.ts';
import { isInsideFolder } from './tables-core.ts';
import { queryWikidata } from './wikidata.ts';

/** @typedef {import('./types.ts').PipelineState} PipelineState */
/** @typedef {import('./types.ts').PullRun} PullRun */
/** @typedef {import('./types.ts').PullMode} PullMode */
/** @typedef {import('./types.ts').PullOutcome} PullOutcome */
/** @typedef {import('./types.ts').FiltersResponse} FiltersResponse */
/** @typedef {import('./pull-core.ts').Http} Http */
/** @typedef {import('./pull-core.ts').Clock} Clock */
/** @typedef {import('./links-core.ts').LinkDeps} LinkDeps */
/** @typedef {import('./report-core.ts').RunReport} RunReport */
/** @typedef {import('../../src/lib/skillbridge-finder/contract/api.ts').ApiListing} ApiListing */
/**
 * @typedef {{
 *   stateDir: string,
 *   deployDir: string,
 *   mode: 'auto' | 'full' | 'weekly',
 *   baseline: boolean,
 *   acceptDrift: boolean,
 *   noLinks: boolean,
 *   fromSnapshot: string | null
 * }} RunOptions
 */
/**
 * @typedef {{
 *   http: Http,
 *   clock: Clock,
 *   linkDeps: LinkDeps,
 *   today(): string,
 *   repoRoot: string,
 *   print?: (line: string) => void
 * }} RunDeps
 */

const MODES = ['auto', 'full', 'weekly'];
const RUNS_KEPT = 2;
const DEFAULT_DEPLOY = 'workers/skillbridge-data/deploy';

export const USAGE = [
	'Usage: node --import tsx content-ops/skillbridge/run.mjs --state <folder> [options]',
	'',
	'  --state <folder>         where the state, saved runs and tables live (outside the repo; required)',
	'  --mode auto|full|weekly  auto (default) follows the state: a full pull whenever the last one fell short',
	'  --baseline               the first full pull, or a re-baseline: nothing is marked New',
	'  --accept-drift           accept additions or removals past 20% after reading the report',
	'  --no-links               make no company website or LinkedIn request (pinned sites still apply)',
	'  --from-snapshot <folder> read filters.json and listings.json from a saved snapshot; no request is made',
	'  --deploy <folder>        the deploy folder (default: ' + DEFAULT_DEPLOY + ' in the repo)',
	'  --help                   show this text',
	'',
	'Exit codes: 0 written, 1 bad arguments or files, 2 the pull stopped, 3 blocked (nothing written).'
].join('\n');

/** @param {string} path */
const slashed = (path) => path.replaceAll('\\', '/').replace(/\/+$/, '');

/**
 * @param {string} path
 * @returns {unknown}
 */
function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * @param {string} path
 * @param {unknown} value
 */
function writeJson(path, value) {
	writeFileSync(path, JSON.stringify(value));
}

/**
 * The newest saved runs are kept; an older dated folder goes, and anything that is not a date is left alone.
 * @param {string} stateDir
 */
function pruneRuns(stateDir) {
	const runs = `${slashed(stateDir)}/runs`;
	const dated = readdirSync(runs)
		.filter((name) => isIsoDate(name) && lstatSync(`${runs}/${name}`).isDirectory())
		.sort();
	for (const name of dated.slice(0, Math.max(0, dated.length - RUNS_KEPT))) {
		assertDirectChild(runs, `${runs}/${name}`);
		rmSync(`${runs}/${name}`, { recursive: true });
	}
}

/**
 * The state as saved, or an empty one before the first run. Throws a static code on a file that cannot be read.
 * @param {string} stateDir
 * @returns {PipelineState}
 */
function loadState(stateDir) {
	const path = join(stateDir, 'state.json');
	if (!existsSync(path)) return emptyState();
	const state = /** @type {PipelineState} */ (readJson(path));
	if (
		typeof state !== 'object' ||
		state === null ||
		state.v !== 1 ||
		typeof state.records !== 'object' ||
		state.records === null
	)
		throw new Error('E_STATE_SHAPE');
	return state;
}

/**
 * The supporting tables kept in the state folder, each checked against its contract.
 * @param {string} stateDir
 * @returns {{ zips?: unknown, crosswalk?: unknown }}
 */
function loadTables(stateDir) {
	/** @type {{ zips?: unknown, crosswalk?: unknown }} */
	const tables = {};
	for (const [name, validate] of /** @type {const} */ ([
		['zips', validateZips],
		['crosswalk', validateCrosswalk]
	])) {
		const path = join(stateDir, 'tables', `${name}.json`);
		if (!existsSync(path)) continue;
		const table = readJson(path);
		if (!validate(table).valid) throw new Error('E_TABLE_INVALID');
		tables[name] = table;
	}
	return tables;
}

/**
 * A pull built from a saved snapshot: nothing is proven gone by it.
 * @param {string} dir
 * @param {string} pullDate
 * @returns {PullRun}
 */
function runFromSnapshot(dir, pullDate) {
	const filters = /** @type {FiltersResponse} */ (readJson(join(dir, 'filters.json')));
	const listed = readJson(join(dir, 'listings.json'));
	if (!Array.isArray(listed)) throw new Error('E_SNAPSHOT_SHAPE');
	/** @type {Map<number, ApiListing>} */
	const byId = new Map();
	for (const row of /** @type {ApiListing[]} */ (listed))
		if (!byId.has(row.id)) byId.set(row.id, row);
	const rows = [...byId.values()].sort((a, b) => a.id - b.id);
	const total = Number(filters.meta?.totalPositions);
	return {
		mode: 'full',
		pullDate,
		totalN: rows.length,
		totalPositions: Number.isFinite(total) ? total : 0,
		filtersProviders: Array.isArray(filters.providers) ? filters.providers : [],
		rows,
		providers: [],
		sumOfTotals: 0,
		sumGate: false,
		dormantSwept: false,
		nextMode: 'full',
		requests: 0,
		elapsedMs: 0
	};
}

/**
 * Link deps that make no request at all, so a pinned site still applies and nothing else is asked.
 * @type {LinkDeps}
 */
const NO_REQUESTS = {
	wikidata: () => Promise.resolve(new Map()),
	siteCheck: () => Promise.resolve(false)
};

/**
 * @param {RunOptions} options
 * @param {RunDeps} deps
 * @returns {Promise<{ exitCode: 0 | 1 | 2 | 3, report: RunReport | null }>}
 */
export async function runPipeline(options, deps) {
	const print = deps.print ?? ((/** @type {string} */ line) => console.log(line));
	const { stateDir, deployDir, baseline, acceptDrift } = options;
	/** @param {string} code */
	const refuse = (code) => {
		print(code);
		return /** @type {const} */ ({ exitCode: 1, report: null });
	};

	// The state holds raw rows with contact names and addresses, so it must live outside the repo.
	if (isInsideFolder(deps.repoRoot, stateDir)) return refuse('E_STATE_INSIDE_REPO');
	const pullDate = deps.today();
	if (!isIsoDate(pullDate)) return refuse('E_BAD_PULL_DATE');

	mkdirSync(stateDir, { recursive: true });
	/** @type {PipelineState} */
	let state;
	/** @type {{ zips?: unknown, crosswalk?: unknown }} */
	let tables;
	try {
		state = loadState(stateDir);
		tables = loadTables(stateDir);
	} catch (error) {
		return refuse(
			error instanceof Error && error.message.startsWith('E_') ? error.message : 'E_STATE_READ'
		);
	}

	const runDir = join(stateDir, 'runs', pullDate);
	/** @type {PullOutcome} */
	let outcome;
	if (options.fromSnapshot !== null) {
		try {
			outcome = { ok: true, run: runFromSnapshot(options.fromSnapshot, pullDate) };
		} catch {
			return refuse('E_SNAPSHOT_READ');
		}
	} else {
		const providers = new Set(Object.values(state.records).map((r) => r.provider));
		outcome = await runPull(
			{
				mode: options.mode === 'auto' ? state.nextMode : options.mode,
				pullDate,
				// An empty name belongs to no provider the server knows; asking for it would be asking for itself.
				publishedProviders: [...providers].filter((name) => name !== ''),
				knownProviders: state.knownProviders
			},
			deps.http,
			deps.clock
		);
	}

	mkdirSync(runDir, { recursive: true });
	if (!outcome.ok) {
		const report = buildReport({ pull: outcome, baseline, pullDate });
		writeJson(join(runDir, 'report.json'), report);
		writeFileSync(join(runDir, 'report.txt'), reportText(report));
		print(reportText(report));
		return { exitCode: 2, report };
	}
	const pull = outcome.run;

	writeJson(join(runDir, 'raw.json'), pull.rows);
	pruneRuns(stateDir);

	/** @type {Map<string, readonly [number, number]>} */
	const zipPoints = new Map();
	const zipRows =
		/** @type {{ rows: [string, number, number][] } | undefined} */ (tables.zips)?.rows ?? [];
	for (const [zip, la, lo] of zipRows) zipPoints.set(zip, [la, lo]);
	const clean = cleanListings(pull.rows, {
		suppression: new Set(state.suppression),
		places: {
			stateBox: (code) => STATE_EXTENTS[code],
			zipPoint: (zip) => zipPoints.get(zip)
		}
	});

	const links = await runLinks(
		clean.listings,
		state.pinnedSites,
		options.noLinks ? NO_REQUESTS : deps.linkDeps
	);

	const check = runCheck({ state, pull, clean, links, pullDate, baseline, acceptDrift });
	const lastWeek = state.lastWeek;
	const week = buildWeek({
		pullDate,
		baseline,
		// A null baseline date means the check has already blocked this run; a date keeps the build from throwing.
		baselineDate: check.nextState.baselineDate ?? pullDate,
		published: check.published,
		overseas: new Set(
			Object.values(check.nextState.records)
				.filter((r) => r.overseas === true)
				.map((r) => r.listing.i)
		),
		aliases: clean.aliases,
		weeks:
			lastWeek !== null && lastWeek.pullDate < pullDate ? [check.week, lastWeek] : [check.week],
		tables
	});

	const report = buildReport({ pull: outcome, clean, check, week, baseline, pullDate });
	writeJson(join(runDir, 'report.json'), report);
	writeFileSync(join(runDir, 'report.txt'), reportText(report));
	print(reportText(report));

	if (check.blockers.length > 0 || week.errors.length > 0) return { exitCode: 3, report };

	writeDeployTree(deployDir, week, nodeTreeFs);
	// The state is replaced whole, so a run that dies half-way leaves last week's file.
	writeJson(join(stateDir, 'state.json.tmp'), check.nextState);
	renameSync(join(stateDir, 'state.json.tmp'), join(stateDir, 'state.json'));
	print('Written. Run the guard and deploy: see content-ops/skillbridge/README.md');
	return { exitCode: 0, report };
}

/**
 * Runs the command from its arguments. Returns the exit code instead of exiting, so a test can call it.
 * @param {string[]} argv
 * @param {RunDeps} deps
 * @returns {Promise<0 | 1 | 2 | 3>}
 */
export async function runCli(argv, deps) {
	const print = deps.print ?? ((/** @type {string} */ line) => console.log(line));
	/** @type {ReturnType<typeof parseArgs>['values']} */
	let values;
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				state: { type: 'string' },
				mode: { type: 'string' },
				baseline: { type: 'boolean' },
				'accept-drift': { type: 'boolean' },
				'no-links': { type: 'boolean' },
				'from-snapshot': { type: 'string' },
				deploy: { type: 'string' },
				help: { type: 'boolean' }
			},
			strict: true,
			allowPositionals: false
		}));
	} catch {
		print(USAGE);
		return 1;
	}
	if (values.help === true) {
		print(USAGE);
		return 0;
	}
	const mode = values.mode ?? 'auto';
	if (typeof values.state !== 'string' || typeof mode !== 'string' || !MODES.includes(mode)) {
		print(USAGE);
		return 1;
	}
	const deploy =
		typeof values.deploy === 'string'
			? values.deploy
			: join(deps.repoRoot, ...DEFAULT_DEPLOY.split('/'));
	const snapshot = values['from-snapshot'];
	const { exitCode } = await runPipeline(
		{
			stateDir: resolve(values.state),
			deployDir: resolve(deploy),
			mode: /** @type {'auto' | 'full' | 'weekly'} */ (mode),
			baseline: values.baseline === true,
			acceptDrift: values['accept-drift'] === true,
			noLinks: values['no-links'] === true,
			fromSnapshot: typeof snapshot === 'string' ? resolve(snapshot) : null
		},
		deps
	);
	return exitCode;
}

/** @returns {string} Today's local date as `YYYY-MM-DD`. */
function localDate() {
	const now = new Date();
	const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const sleep = (/** @type {number} */ ms) =>
		new Promise((done) => {
			setTimeout(done, ms);
		});
	process.exitCode = await runCli(process.argv.slice(2), {
		http: createHttp(),
		clock: realClock,
		linkDeps: {
			wikidata: (names) => queryWikidata(names, { fetch: globalThis.fetch, sleep }),
			siteCheck: createSiteCheck()
		},
		today: localDate,
		repoRoot: fileURLToPath(new URL('../../', import.meta.url))
	});
}
