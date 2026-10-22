import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkConfig, checkTree, dataConfigPath, guardAndDeploy } from './guard-core.ts';
import type { GuardDeps, TreeEntry } from './guard-core.ts';
import { ASSET_MAX_FILES, ASSET_MAX_FILE_BYTES, DATA_HEADERS_FILE } from './config.ts';
import { stripJsoncComments } from '../../src/lib/ci/worker-config-policy.ts';
import { MAX_FILE_BYTES } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import { cleanListing } from '../../src/lib/skillbridge-finder/fixtures/clean.ts';

// Max deploys the week's files from his own login, so the guard is the last thing between a slip and a public
// change: only the static-files Worker's config may be used, the tree must hold exactly the files the app may
// fetch and each one must be valid, and wrangler runs only after every check passes. These tests use an
// in-memory disk and a fake runner; nothing here touches the real deploy folder or wrangler.

const REPO = '/repo';
const FOLDER = `${REPO}/workers/skillbridge-data`;
const CONFIG = `${FOLDER}/wrangler.jsonc`;
const DEPLOY = `${FOLDER}/deploy`;
const WEEK_OLD = '2026-10-12';
const WEEK_NEW = '2026-10-19';
const NODE = '/bin/node';
const WRANGLER_JS = '/repo/node_modules/wrangler/bin/wrangler.js';

const committedConfig = readFileSync(
	new URL('../../workers/skillbridge-data/wrangler.jsonc', import.meta.url),
	'utf8'
);
const configObject = () =>
	JSON.parse(stripJsoncComments(committedConfig)) as Record<string, unknown>;

type Node = { text?: string; bytes: number; kind?: 'dir' | 'link' };
type Tree = Map<string, Node>;

function put(tree: Tree, path: string, text: string): void {
	tree.set(path, { text, bytes: Buffer.byteLength(text) });
}

function goodTree(): Tree {
	const tree: Tree = new Map();
	put(tree, '_headers', DATA_HEADERS_FILE);
	const names = ['remote', 'territories'] as const;
	for (const week of [WEEK_OLD, WEEK_NEW]) {
		names.forEach((file, n) => {
			const listings = [cleanListing({ i: 1001 + n })];
			put(
				tree,
				`skillbridge-data/w/${week}/${file}.json`,
				JSON.stringify({ v: 1, pullDate: week, file, listings })
			);
		});
		put(
			tree,
			`skillbridge-data/w/${week}/ids.json`,
			JSON.stringify({ v: 1, pullDate: week, ids: [[1001, WEEK_OLD]], aliases: [] })
		);
		put(
			tree,
			`skillbridge-data/w/${week}/changes.json`,
			JSON.stringify({
				v: 1,
				weeks: [{ pullDate: WEEK_NEW, added: [1001], removed: [], newOrgs: [] }]
			})
		);
	}
	const files = names.map((name) => ({
		name,
		count: 1,
		bytes: tree.get(`skillbridge-data/w/${WEEK_NEW}/${name}.json`)!.bytes
	}));
	put(
		tree,
		'skillbridge-data/index.json',
		JSON.stringify({ v: 1, pullDate: WEEK_NEW, baseline: false, baselineDate: WEEK_OLD, files })
	);
	put(
		tree,
		'skillbridge-data/tables/zips.json',
		JSON.stringify({ v: 1, rows: [['21046', 39.2, -76.86]] })
	);
	put(
		tree,
		'skillbridge-data/tables/crosswalk.json',
		JSON.stringify({ v: 1, rows: [['91B', 'Army', '49-3023.00', 'Example Technicians']] })
	);
	return tree;
}

type Setup = {
	tree?: Tree | null;
	config?: string;
	cwd?: string;
	repoRoot?: string;
	exitCode?: number;
	runnerFails?: boolean;
	env?: Record<string, string | undefined>;
};

function makeDeps(setup: Setup = {}) {
	const tree = setup.tree === undefined ? goodTree() : setup.tree;
	const config = setup.config ?? committedConfig;
	const repoRoot = setup.repoRoot ?? REPO;
	const reads: string[] = [];
	const runs: { file: string; args: string[]; options: { cwd: string } }[] = [];
	const deps: GuardDeps = {
		repoRoot,
		readText(path) {
			reads.push(path);
			if (path === CONFIG) return config;
			const node = path.startsWith(`${DEPLOY}/`)
				? tree?.get(path.slice(DEPLOY.length + 1))
				: undefined;
			if (node?.text !== undefined) return node.text;
			throw new Error('E_TEST_NO_FILE');
		},
		listTree(dir) {
			if (dir !== DEPLOY || tree === null) throw new Error('E_TEST_NO_DIR');
			return [...tree].map(([path, node]): TreeEntry => ({
				path,
				bytes: node.bytes,
				isFile: node.kind === undefined,
				isSymlink: node.kind === 'link'
			}));
		},
		runner(file, args, options) {
			runs.push({ file, args, options });
			return setup.runnerFails === true
				? Promise.reject(new Error('E_TEST_SPAWN'))
				: Promise.resolve(setup.exitCode ?? 0);
		},
		wranglerJs: WRANGLER_JS,
		nodePath: NODE,
		cwd: setup.cwd ?? FOLDER,
		env: setup.env ?? {}
	};
	return { deps, reads, runs };
}

async function guard(setup: Setup = {}, configPath = CONFIG) {
	const made = makeDeps(setup);
	const outcome = await guardAndDeploy(made.deps, { configPath });
	return { outcome, ...made };
}

describe('checkConfig', () => {
	it('uses the shared policy and comment stripper, never a second copy of them', () => {
		const source = readFileSync(new URL('./guard-core.ts', import.meta.url), 'utf8');
		expect(source).not.toContain('function findDataWorkerConfigViolations');
		expect(source).not.toContain('function stripJsoncComments');
		expect(source).toMatch(
			/import \{[^}]*findDataWorkerConfigViolations[^}]*\} from '[^']*skillbridge-data-config-policy\.ts'/
		);
		expect(source).toMatch(
			/import \{[^}]*stripJsoncComments[^}]*\} from '[^']*worker-config-policy\.ts'/
		);
	});

	it('accepts the committed data Worker config', () => {
		expect(checkConfig(CONFIG, makeDeps().deps)).toEqual([]);
	});

	it('accepts the same file spelled with backslashes, another case, or a trailing-slash root', () => {
		const { deps } = makeDeps({ repoRoot: 'C:\\Users\\Max\\Repo\\' });
		expect(checkConfig(dataConfigPath('C:\\Users\\Max\\Repo\\'), deps)).not.toContain(
			'E_WRONG_CONFIG'
		);
		expect(
			checkConfig('c:\\users\\max\\repo\\Workers\\SkillBridge-Data\\wrangler.jsonc', deps)
		).not.toContain('E_WRONG_CONFIG');
		expect(dataConfigPath('C:\\Users\\Max\\Repo\\')).toBe(
			'C:/Users/Max/Repo/workers/skillbridge-data/wrangler.jsonc'
		);
	});

	it.each([
		['the app root config', '/repo/wrangler.toml'],
		['the retrieve Worker config', '/repo/workers/retrieve/wrangler.jsonc'],
		['a copy of the data config somewhere else', '/tmp/copy/wrangler.jsonc'],
		['a path climbing out with ..', '/repo/workers/skillbridge-data/../retrieve/wrangler.jsonc'],
		[
			'a path with .. that climbs back in',
			'/repo/workers/skillbridge-data/../skillbridge-data/wrangler.jsonc'
		],
		['a relative path', 'workers/skillbridge-data/wrangler.jsonc']
	])('refuses %s and reads nothing from it', (_name, path) => {
		const { deps, reads } = makeDeps();
		expect(checkConfig(path, deps)).toEqual(['E_WRONG_CONFIG']);
		expect(reads).toEqual([]);
	});

	it.each([
		['a script entry point (main)', { main: 'src/index.ts' }],
		['a binding', { kv_namespaces: [{ binding: 'KV', id: 'x' }] }],
		['run_worker_first', { assets: { directory: './deploy', run_worker_first: true } }],
		['workers_dev on', { workers_dev: true }],
		[
			'a second route',
			{
				routes: [
					{ pattern: 'ask214.com/skillbridge-data/*', zone_name: 'ask214.com' },
					{ pattern: 'ask214.com/*', zone_name: 'ask214.com' }
				]
			}
		],
		['another Worker name', { name: 'ask214' }]
	])('refuses a config with %s', (_name, change) => {
		const config = JSON.stringify({ ...configObject(), ...change });
		const problems = checkConfig(CONFIG, makeDeps({ config }).deps);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems.every((p) => p.startsWith('E_CONFIG_POLICY:'))).toBe(true);
	});

	it.each([
		['another folder', '../retrieve/deploy'],
		['the data folder itself', '.'],
		['an absolute folder', '/etc'],
		['the deploy folder in another case', './Deploy'],
		['the deploy folder without the leading dot', 'deploy'],
		['the deploy folder with a trailing slash', './deploy/'],
		// U+212A lowercases to k in JavaScript, but Windows keeps it a different letter from k.
		[
			'a folder whose name holds a Kelvin sign',
			`../s${String.fromCharCode(0x212a)}illbridge-data/deploy`
		]
	])('refuses assets served from %s', (_name, directory) => {
		const config = JSON.stringify({ ...configObject(), assets: { directory } });
		expect(checkConfig(CONFIG, makeDeps({ config }).deps)).toContain('E_ASSETS_DIR');
	});

	it.each([
		['text that is not JSON', '{ not json'],
		['JSON that is not an object', '[1, 2]'],
		['an empty file', '']
	])('refuses %s as unparseable', (_name, config) => {
		expect(checkConfig(CONFIG, makeDeps({ config }).deps)).toEqual(['E_CONFIG_PARSE']);
	});

	// The shared comment stripper ends a // comment only at a line feed, but wrangler's own parser ends it at a
	// carriage return too, so text after a lone CR is a comment to the guard and live config to wrangler.
	const CR = String.fromCharCode(13);
	const hidden = (): string =>
		committedConfig
			.replaceAll('\r\n', '\n')
			.replace(
				'"preview_urls": false',
				`"preview_urls": false, // weekly data${CR}  "main": "src/x.js", ` +
					'"routes": [{ "pattern": "ask214.com/*", "zone_name": "ask214.com" }], ' +
					'"kv_namespaces": [{ "binding": "KV", "id": "x" }]'
			);

	it('refuses a config that hides keys after a lone carriage return in a comment', () => {
		expect(hidden()).toContain('"main"');
		expect(checkConfig(CONFIG, makeDeps({ config: hidden() }).deps)).toEqual(['E_CONFIG_PARSE']);
	});

	it('refuses a lone carriage return anywhere, even outside a comment', () => {
		const config = committedConfig.replaceAll('\r\n', '\n').replace('"name"', `${CR}"name"`);
		expect(checkConfig(CONFIG, makeDeps({ config }).deps)).toEqual(['E_CONFIG_PARSE']);
	});

	it('still accepts the committed config with Windows line ends', () => {
		const config = committedConfig.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
		expect(checkConfig(CONFIG, makeDeps({ config }).deps)).toEqual([]);
	});
});

describe('guardAndDeploy: where it runs', () => {
	it.each([REPO, `${REPO}/`, `${FOLDER}/../..`])(
		'refuses to start from the app root (%s) and never runs wrangler',
		async (cwd) => {
			const { outcome, runs } = await guard({ cwd });
			expect(outcome.ok).toBe(false);
			expect(outcome.problems).toContain('E_APP_ROOT');
			expect(runs).toEqual([]);
		}
	);

	it('refuses an app root spelled with another case and backslashes', async () => {
		const { outcome, runs } = await guard({ repoRoot: 'C:/Repo', cwd: 'c:\\repo\\' });
		expect(outcome.problems).toContain('E_APP_ROOT');
		expect(runs).toEqual([]);
	});

	it('runs from the data Worker folder', async () => {
		const { outcome } = await guard({ cwd: FOLDER });
		expect(outcome.problems).toEqual([]);
	});
});

describe('checkTree and guardAndDeploy: what may be deployed', () => {
	const stray = (rel: string) => (t: Tree) => put(t, rel, 'x');
	const cases: [string, (t: Tree) => void, string][] = [
		['a stray file at the root', stray('index.html'), 'E_STRAY:index.html'],
		[
			'a stray file in the data folder',
			stray('skillbridge-data/notes.txt'),
			'E_STRAY:skillbridge-data/notes.txt'
		],
		[
			'a folder that is not a date',
			stray('skillbridge-data/w/notes/x.json'),
			'E_STRAY:skillbridge-data/w/notes/x.json'
		],
		[
			'a date with a suffix',
			stray('skillbridge-data/w/2026-10-07.tmp/remote.json'),
			'E_STRAY:skillbridge-data/w/2026-10-07.tmp/remote.json'
		],
		[
			'a date that is not a real day',
			stray('skillbridge-data/w/2026-02-30/remote.json'),
			'E_STRAY:skillbridge-data/w/2026-02-30/remote.json'
		],
		[
			'a region file name off the list',
			stray(`skillbridge-data/w/${WEEK_NEW}/europe.json`),
			`E_STRAY:skillbridge-data/w/${WEEK_NEW}/europe.json`
		],
		[
			'a table off the list',
			stray('skillbridge-data/tables/secrets.json'),
			'E_STRAY:skillbridge-data/tables/secrets.json'
		],
		[
			'a bases table, which is no longer published now that distance is by ZIP only',
			(t) => put(t, 'skillbridge-data/tables/bases.json', JSON.stringify({ v: 1, rows: [] })),
			'E_STRAY:skillbridge-data/tables/bases.json'
		],
		[
			'a file next to the index',
			stray('skillbridge-data/index.json.bak'),
			'E_STRAY:skillbridge-data/index.json.bak'
		],
		[
			'a third dated folder',
			(t) => put(t, 'skillbridge-data/w/2026-10-05/remote.json', '{}'),
			'E_TOO_MANY_WEEKS'
		],
		[
			'an empty third dated folder',
			(t) => t.set('skillbridge-data/w/2026-10-05', { bytes: 0, kind: 'dir' }),
			'E_TOO_MANY_WEEKS'
		],
		[
			'an index naming a file that is missing',
			(t) => t.delete(`skillbridge-data/w/${WEEK_NEW}/remote.json`),
			`E_MISSING_FILE:skillbridge-data/w/${WEEK_NEW}/remote.json`
		],
		[
			'a file whose size is not the index size',
			(t) =>
				t.set(`skillbridge-data/w/${WEEK_NEW}/remote.json`, {
					...t.get(`skillbridge-data/w/${WEEK_NEW}/remote.json`)!,
					bytes: 1
				}),
			`E_BYTES:skillbridge-data/w/${WEEK_NEW}/remote.json`
		],
		[
			'a file whose listings are not the index count',
			(t) => {
				const path = 'skillbridge-data/index.json';
				const index = JSON.parse(t.get(path)!.text!) as { files: { count: number }[] };
				index.files[0]!.count = 5;
				put(t, path, JSON.stringify(index));
			},
			`E_COUNT:skillbridge-data/w/${WEEK_NEW}/remote.json`
		],
		[
			'a file over 25 MiB',
			(t) => t.set('skillbridge-data/tables/zips.json', { bytes: ASSET_MAX_FILE_BYTES + 1 }),
			'E_FILE_TOO_BIG:skillbridge-data/tables/zips.json'
		],
		[
			'more files than a Worker version may hold',
			(t) => {
				t.clear();
				for (let i = 0; i <= ASSET_MAX_FILES; i++)
					t.set(`skillbridge-data/w/n${i}.json`, { bytes: 1 });
			},
			'E_TOO_MANY_FILES'
		],
		[
			'a listing file that fails the contract',
			(t) =>
				put(
					t,
					`skillbridge-data/w/${WEEK_OLD}/remote.json`,
					JSON.stringify({ v: 1, pullDate: WEEK_OLD, file: 'remote', listings: [{ i: 1 }] })
				),
			`E_INVALID:skillbridge-data/w/${WEEK_OLD}/remote.json`
		],
		[
			'a listing file filed under another date',
			(t) =>
				put(
					t,
					`skillbridge-data/w/${WEEK_OLD}/remote.json`,
					JSON.stringify({ v: 1, pullDate: WEEK_NEW, file: 'remote', listings: [] })
				),
			`E_INVALID:skillbridge-data/w/${WEEK_OLD}/remote.json`
		],
		[
			'a listing file that names a different region than its file name',
			(t) =>
				put(
					t,
					`skillbridge-data/w/${WEEK_OLD}/remote.json`,
					JSON.stringify({ v: 1, pullDate: WEEK_OLD, file: 'territories', listings: [] })
				),
			`E_INVALID:skillbridge-data/w/${WEEK_OLD}/remote.json`
		],
		[
			'an ids file filed under another date',
			(t) =>
				put(
					t,
					`skillbridge-data/w/${WEEK_OLD}/ids.json`,
					JSON.stringify({ v: 1, pullDate: WEEK_NEW, ids: [[1001, WEEK_OLD]], aliases: [] })
				),
			`E_INVALID:skillbridge-data/w/${WEEK_OLD}/ids.json`
		],
		[
			'a table that fails the contract',
			(t) =>
				put(
					t,
					'skillbridge-data/tables/zips.json',
					JSON.stringify({ v: 1, rows: [['abc', 1, 2]] })
				),
			'E_INVALID:skillbridge-data/tables/zips.json'
		],
		[
			'an ids file that is not JSON',
			(t) => put(t, `skillbridge-data/w/${WEEK_NEW}/ids.json`, 'not json'),
			`E_INVALID:skillbridge-data/w/${WEEK_NEW}/ids.json`
		],
		[
			'a changes file that fails the contract',
			(t) =>
				put(t, `skillbridge-data/w/${WEEK_NEW}/changes.json`, JSON.stringify({ v: 2, weeks: [] })),
			`E_INVALID:skillbridge-data/w/${WEEK_NEW}/changes.json`
		],
		[
			'headers that differ',
			(t) => put(t, '_headers', `${DATA_HEADERS_FILE}  X-Extra: 1\n`),
			'E_HEADERS'
		],
		['no headers file', (t) => t.delete('_headers'), 'E_HEADERS'],
		[
			'a symlink in place of a file',
			(t) => t.set('skillbridge-data/tables/zips.json', { bytes: 0, kind: 'link' }),
			'E_SYMLINK:skillbridge-data/tables/zips.json'
		],
		[
			'a symlinked folder',
			(t) => t.set('skillbridge-data/w', { bytes: 0, kind: 'link' }),
			'E_SYMLINK:skillbridge-data/w'
		],
		['no index', (t) => t.delete('skillbridge-data/index.json'), 'E_INDEX'],
		[
			'an index that fails the contract',
			(t) => put(t, 'skillbridge-data/index.json', '{"v":1}'),
			'E_INDEX'
		],
		[
			'an index naming a week with no folder',
			(t) => {
				const path = 'skillbridge-data/index.json';
				const index = JSON.parse(t.get(path)!.text!) as { pullDate: string };
				index.pullDate = '2026-10-26';
				put(t, path, JSON.stringify(index));
			},
			'E_MISSING_WEEK'
		],
		[
			'a week with no ids file',
			(t) => t.delete(`skillbridge-data/w/${WEEK_NEW}/ids.json`),
			`E_MISSING_FILE:skillbridge-data/w/${WEEK_NEW}/ids.json`
		],
		[
			'a week with no changes file',
			(t) => t.delete(`skillbridge-data/w/${WEEK_NEW}/changes.json`),
			`E_MISSING_FILE:skillbridge-data/w/${WEEK_NEW}/changes.json`
		]
	];

	it.each(cases)('refuses %s and never runs wrangler', async (_name, change, code) => {
		const tree = goodTree();
		change(tree);
		const { outcome, runs } = await guard({ tree });
		expect(outcome.ok).toBe(false);
		expect(outcome.problems).toContain(code);
		expect(runs).toEqual([]);
	});

	it('refuses when there is no deploy folder', async () => {
		const { outcome, runs } = await guard({ tree: null });
		expect(outcome).toEqual({ ok: false, problems: ['E_NO_TREE'] });
		expect(runs).toEqual([]);
	});

	// The app refuses a data file over MAX_FILE_BYTES while it streams in, so a larger one would deploy fine and
	// then never load for anyone; Cloudflare's own 25 MiB limit still applies to every other file.
	const resized = (bytes: number): Tree => {
		const tree = goodTree();
		const path = `skillbridge-data/w/${WEEK_NEW}/remote.json`;
		tree.set(path, { ...tree.get(path)!, bytes });
		const indexPath = 'skillbridge-data/index.json';
		const index = JSON.parse(tree.get(indexPath)!.text!) as {
			files: { name: string; bytes: number }[];
		};
		index.files.find((f) => f.name === 'remote')!.bytes = bytes;
		put(tree, indexPath, JSON.stringify(index));
		return tree;
	};

	it('refuses a data file one byte over what the app will read', async () => {
		const { outcome, runs } = await guard({ tree: resized(MAX_FILE_BYTES + 1) });
		expect(outcome.ok).toBe(false);
		expect(outcome.problems).toEqual([`E_FILE_TOO_BIG:skillbridge-data/w/${WEEK_NEW}/remote.json`]);
		expect(runs).toEqual([]);
	});

	it('allows a data file of exactly what the app will read', async () => {
		const { outcome } = await guard({ tree: resized(MAX_FILE_BYTES) });
		expect(outcome.problems).toEqual([]);
	});

	it('keeps Cloudflare 25 MiB limit for any other file', () => {
		const tree = goodTree();
		tree.set('notes.bin', { bytes: ASSET_MAX_FILE_BYTES + 1 });
		tree.set('other.bin', { bytes: MAX_FILE_BYTES + 1 });
		const problems = checkTree(DEPLOY, makeDeps({ tree }).deps);
		expect(problems).toContain('E_FILE_TOO_BIG:notes.bin');
		expect(problems).not.toContain('E_FILE_TOO_BIG:other.bin');
	});

	it('allows exactly the most files a Worker version may hold', () => {
		const tree: Tree = new Map();
		for (let i = 0; i < ASSET_MAX_FILES; i++)
			tree.set(`skillbridge-data/w/n${i}.json`, { bytes: 1 });
		const { deps } = makeDeps({ tree });
		expect(checkTree(DEPLOY, deps)).not.toContain('E_TOO_MANY_FILES');
	});

	it('never reads through a symlink', () => {
		const tree = goodTree();
		tree.set('_headers', { bytes: 0, kind: 'link' });
		const { deps, reads } = makeDeps({ tree });
		checkTree(DEPLOY, deps);
		expect(reads).not.toContain(`${DEPLOY}/_headers`);
	});

	it('reports codes and paths only, never file contents', () => {
		const tree = goodTree();
		put(tree, 'skillbridge-data/w/2026-10-19/ids.json', 'SECRET-CONTENT-123');
		const { deps } = makeDeps({ tree });
		expect(checkTree(DEPLOY, deps).join('\n')).not.toContain('SECRET');
	});
});

// Wrangler inherits the whole environment: CLOUDFLARE_ENV would deploy a differently named Worker, and an API
// token would replace the keyring login, which is meant to be the one stored credential.
describe('guardAndDeploy: the environment wrangler would inherit', () => {
	const VALUE = 'not-a-real-value-123';

	it.each([
		'CLOUDFLARE_ENV',
		'CLOUDFLARE_API_TOKEN',
		'CF_API_TOKEN',
		'CLOUDFLARE_API_KEY',
		'CF_API_KEY'
	])(
		'refuses when %s is set, names it without its value, and never runs wrangler',
		async (name) => {
			const { outcome, runs } = await guard({ env: { [name]: VALUE } });
			expect(outcome.ok).toBe(false);
			expect(outcome.problems).toEqual([`E_ENV:${name}`]);
			expect(JSON.stringify(outcome)).not.toContain(VALUE);
			expect(runs).toEqual([]);
		}
	);

	it('names every such variable that is set', async () => {
		const env = { CF_API_TOKEN: VALUE, CLOUDFLARE_ENV: VALUE };
		const { outcome } = await guard({ env });
		expect(outcome.problems).toEqual(['E_ENV:CLOUDFLARE_ENV', 'E_ENV:CF_API_TOKEN']);
	});

	it('ignores variables that are empty, unset, or unrelated', async () => {
		const env = { CLOUDFLARE_API_TOKEN: '', CF_API_KEY: undefined, PATH: VALUE, HOME: VALUE };
		const { outcome, runs } = await guard({ env });
		expect(outcome).toEqual({ ok: true, problems: [], exitCode: 0 });
		expect(runs).toHaveLength(1);
	});
});

describe('guardAndDeploy: the deploy', () => {
	it('passes a good tree of two weeks and runs wrangler once, from the data Worker folder, with its own config', async () => {
		const { outcome, runs } = await guard();
		expect(outcome).toEqual({ ok: true, problems: [], exitCode: 0 });
		expect(runs).toEqual([
			{
				file: NODE,
				args: [WRANGLER_JS, 'deploy', '--config', CONFIG],
				options: { cwd: FOLDER }
			}
		]);
	});

	it('also passes a first week with nothing older', async () => {
		const tree = goodTree();
		for (const key of [...tree.keys()]) if (key.includes(`/w/${WEEK_OLD}/`)) tree.delete(key);
		const { outcome } = await guard({ tree });
		expect(outcome.problems).toEqual([]);
	});

	it('reports a failing wrangler as not ok, with its exit code', async () => {
		const { outcome } = await guard({ exitCode: 1 });
		expect(outcome).toEqual({ ok: false, problems: [], exitCode: 1 });
	});

	it('reports a runner that cannot start as a problem instead of throwing', async () => {
		const { outcome } = await guard({ runnerFails: true });
		expect(outcome).toEqual({ ok: false, problems: ['E_RUNNER'] });
	});

	it('reads and deploys with its own spelling of the config path, not the caller one', async () => {
		const { outcome, runs } = await guard({}, '/REPO/Workers/SkillBridge-Data/wrangler.jsonc');
		expect(outcome.ok).toBe(true);
		expect(runs[0]?.args).toEqual([WRANGLER_JS, 'deploy', '--config', CONFIG]);
	});
});

describe('deploy.mjs', () => {
	const unsafeSpawnUses = (source: string): string[] => {
		const found: string[] = [];
		if (/\bexec\s*\(/.test(source)) found.push('exec(');
		if (/\bexecSync\b/.test(source)) found.push('execSync');
		if (/shell\s*:\s*true/.test(source)) found.push('shell: true');
		if (/\b(spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"`]/.test(source))
			found.push('string command');
		return found;
	};

	it('would catch each unsafe way to start a process', () => {
		expect(unsafeSpawnUses('exec(`wrangler deploy ${x}`)')).toEqual(['exec(']);
		expect(unsafeSpawnUses("execSync('wrangler deploy')")).toEqual(['execSync']);
		expect(unsafeSpawnUses('spawn(file, args, { shell: true })')).toEqual(['shell: true']);
		expect(unsafeSpawnUses("spawn('wrangler deploy')")).toEqual(['string command']);
	});

	it('starts wrangler with a file and an argument list, never through a shell', () => {
		const source = readFileSync(new URL('./deploy.mjs', import.meta.url), 'utf8');
		expect(unsafeSpawnUses(source)).toEqual([]);
		expect(source).toContain('shell: false');
		expect(source).toContain("stdio: 'inherit'");
	});
});
