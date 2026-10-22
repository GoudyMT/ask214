/**
 * The pre-deploy guard for the SkillBridge data Worker, as pure logic: the disk and the process runner are
 * injected. Max deploys from his own login, so the guard checks first that only the static-files Worker's config
 * is used, that the tree holds exactly the files the app may fetch and each one is valid, and only then runs
 * wrangler. Problems are static codes, optionally `CODE:detail` with a path or key; file contents never appear.
 */

import { findDataWorkerConfigViolations } from '../../src/lib/ci/skillbridge-data-config-policy.ts';
import { stripJsoncComments } from '../../src/lib/ci/worker-config-policy.ts';
import { isIsoDate, REGION_FILE_NAMES } from '../../src/lib/skillbridge-finder/contract/places.ts';
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
import type { ContractResult } from '../../src/lib/skillbridge-finder/contract/validate.ts';
import { MAX_FILE_BYTES } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import type { IndexFile } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import {
	ASSET_MAX_FILES,
	ASSET_MAX_FILE_BYTES,
	DATA_HEADERS_FILE,
	DEPLOY_DATA_DIR,
	DEPLOY_WEEKS_KEPT
} from './config.ts';

export type TreeEntry = { path: string; bytes: number; isFile: boolean; isSymlink: boolean };

export type GuardDeps = {
	/** Absolute. */
	repoRoot: string;
	readText(path: string): string;
	/** Every entry under `dir`, with paths relative to it using `/`; throws when `dir` does not exist. */
	listTree(dir: string): TreeEntry[];
	/** Starts a program from a file and an argument list, never through a shell; resolves with its exit code. */
	runner(file: string, args: string[], options: { cwd: string }): Promise<number>;
	/** Absolute path of wrangler's `bin/wrangler.js`. */
	wranglerJs: string;
	/** The node executable that runs it. */
	nodePath: string;
	/** The shell's folder when Max ran the command. */
	cwd: string;
	/** The environment wrangler would inherit. */
	env: Record<string, string | undefined>;
	/** Whether a file or folder exists at `path`. Existence only: the guard never opens an env file. */
	exists(path: string): boolean;
};

/** Files wrangler loads from its working folder to fill in any variable the shell does not set. */
const DOTENV_FILES = ['.env', '.env.local'] as const;

/**
 * Environment variables that make a deploy do something other than what the committed config and the keyring login
 * say. Wrangler reads many (a list of the known ones would miss the next), so every variable whose name starts with
 * one of these prefixes is refused, in any letter case since Windows names are case-insensitive. Among them:
 * - CLOUDFLARE_ENV deploys a Worker named `<name>-<env>`, and WRANGLER_CI_OVERRIDE_NAME renames the Worker;
 * - an API token or key replaces the keyring login, which is meant to be the one stored credential, and
 *   CLOUDFLARE_AUTH_USE_KEYRING=false lets an old file-stored login take its place;
 * - an account id points the deploy at another account;
 * - an API base URL, or the OAuth domain and endpoints, send every call (the keyring token included) to another host.
 * Only the names are ever reported, never a value.
 */
const FORBIDDEN_ENV_PREFIXES = ['CLOUDFLARE_', 'CF_', 'WRANGLER_'] as const;

const DATA_WORKER_DIR = 'workers/skillbridge-data';
/** The assets directory the committed data config names, relative to the config's folder. */
const ASSETS_DIRECTORY = './deploy';
const DATA_WEEK_ROOT = `${DEPLOY_DATA_DIR}/w`;

/** Forward slashes and no trailing slash, so paths from `fileURLToPath` and from a test read the same. */
function slashed(p: string): string {
	return p.replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * A path with `.` and `..` folded away and the case dropped, for comparing two spellings of one place. Folding
 * case can also equate two places Windows keeps apart (U+212A lowercases to k), so it is used only where a false
 * match is harmless: the config is always read by its own canonical spelling, and a match on the shell's folder
 * only refuses. Nothing here decides which folder wrangler uploads.
 */
function sameKey(p: string): string {
	const parts: string[] = [];
	for (const part of p.replaceAll('\\', '/').split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') parts.pop();
		else parts.push(part.toLowerCase());
	}
	return (p.replaceAll('\\', '/').startsWith('/') ? '/' : '') + parts.join('/');
}

function workerFolder(repoRoot: string): string {
	return `${slashed(repoRoot)}/${DATA_WORKER_DIR}`;
}

export function dataConfigPath(repoRoot: string): string {
	return `${workerFolder(repoRoot)}/wrangler.jsonc`;
}

/** The problems with the data Worker's config; refuses any file but the committed data config. */
export function checkConfig(configPath: string, deps: GuardDeps): string[] {
	const expected = dataConfigPath(deps.repoRoot);
	const climbs = configPath.replaceAll('\\', '/').split('/').includes('..');
	if (climbs || sameKey(configPath) !== sameKey(expected)) return ['E_WRONG_CONFIG'];

	let config: unknown;
	try {
		const text = deps.readText(expected);
		// A carriage return on its own is where JSONC readers disagree about where a // comment ends. Refusing it
		// keeps the guard and wrangler reading the same keys, whatever the shared comment stripper does.
		if (/\r(?!\n)/.test(text)) return ['E_CONFIG_PARSE'];
		config = JSON.parse(stripJsoncComments(text));
	} catch {
		return ['E_CONFIG_PARSE'];
	}
	if (typeof config !== 'object' || config === null || Array.isArray(config))
		return ['E_CONFIG_PARSE'];

	const problems = findDataWorkerConfigViolations(config as Record<string, unknown>).map(
		(violation) => `E_CONFIG_POLICY:${violation}`
	);
	// Exactly the committed spelling, compared as plain text: wrangler resolves the folder on the real disk, and any
	// other spelling (another case, a Unicode look-alike) could name a folder the tree check never looked at.
	const directory = (config as { assets?: { directory?: unknown } }).assets?.directory;
	if (directory !== ASSETS_DIRECTORY) problems.push('E_ASSETS_DIR');
	return problems;
}

type Kind = 'headers' | 'index' | 'region' | 'ids' | 'changes' | 'zips' | 'crosswalk';
type Placed = { kind: Kind; date?: string; name?: string };

const REGION_NAMES: ReadonlySet<string> = new Set(REGION_FILE_NAMES);
/** The supporting tables the app fetches: distance is by ZIP only, so there is no installation list. */
const TABLE_NAMES: ReadonlySet<string> = new Set(['zips', 'crosswalk']);

/** Where a file path sits in the layout the app may fetch, or null for a file that has no place in it. */
function place(rel: string): Placed | null {
	if (rel === '_headers') return { kind: 'headers' };
	if (rel === `${DEPLOY_DATA_DIR}/index.json`) return { kind: 'index' };
	const parts = rel.split('/');
	const [root, folder, leaf, last] = parts;
	if (root !== DEPLOY_DATA_DIR || leaf === undefined) return null;
	if (folder === 'tables' && parts.length === 3 && leaf.endsWith('.json')) {
		const name = leaf.slice(0, -'.json'.length);
		return TABLE_NAMES.has(name) ? { kind: name as Kind, name } : null;
	}
	if (folder === 'w' && parts.length === 4 && last !== undefined && last.endsWith('.json')) {
		const name = last.slice(0, -'.json'.length);
		if (!isIsoDate(leaf)) return null;
		if (name === 'ids' || name === 'changes') return { kind: name, date: leaf };
		return REGION_NAMES.has(name) ? { kind: 'region', date: leaf, name } : null;
	}
	return null;
}

const VALIDATORS: Record<Exclude<Kind, 'headers'>, (raw: unknown) => ContractResult> = {
	index: validateIndex,
	region: validateRegionFile,
	ids: validateIds,
	changes: validateChanges,
	zips: validateZips,
	crosswalk: validateCrosswalk
};

/** The problems with the deploy tree (the assets directory): stray files, wrong shapes, broken contract. */
export function checkTree(deployRoot: string, deps: GuardDeps): string[] {
	const root = slashed(deployRoot);
	let entries: TreeEntry[];
	try {
		entries = deps.listTree(root);
	} catch {
		return ['E_NO_TREE'];
	}

	const problems: string[] = [];
	const files = new Map<string, TreeEntry>();
	const dates = new Set<string>();
	for (const entry of entries) {
		if (entry.isSymlink) problems.push(`E_SYMLINK:${entry.path}`);
		else if (entry.isFile) files.set(entry.path, entry);
		else {
			const parts = entry.path.split('/');
			const [rootDir, w, date] = parts;
			if (parts.length === 3 && rootDir === DEPLOY_DATA_DIR && w === 'w' && isIsoDate(date))
				dates.add(date);
		}
	}
	// Refused before any file is read, so an absurd tree costs nothing to turn away.
	if (files.size > ASSET_MAX_FILES) return [...problems, 'E_TOO_MANY_FILES'];

	const placed = new Map<string, Placed>();
	for (const path of files.keys()) {
		const where = place(path);
		if (where === null) problems.push(`E_STRAY:${path}`);
		else {
			placed.set(path, where);
			if (where.date !== undefined) dates.add(where.date);
		}
	}
	if (dates.size > DEPLOY_WEEKS_KEPT) problems.push('E_TOO_MANY_WEEKS');

	// The app refuses a data file past MAX_FILE_BYTES while it streams in, so a larger one would deploy and then
	// never load; any other file only has Cloudflare's limit to meet.
	for (const [path, entry] of files) {
		const kind = placed.get(path)?.kind;
		const limit = kind !== undefined && kind !== 'headers' ? MAX_FILE_BYTES : ASSET_MAX_FILE_BYTES;
		if (entry.bytes > limit) problems.push(`E_FILE_TOO_BIG:${path}`);
	}

	const read = (path: string): string | null => {
		try {
			return deps.readText(`${root}/${path}`);
		} catch {
			return null;
		}
	};
	const parsed = new Map<string, unknown>();

	if (!placed.has('_headers') || read('_headers') !== DATA_HEADERS_FILE) problems.push('E_HEADERS');

	for (const [path, where] of placed) {
		if (where.kind === 'headers') continue;
		const entry = files.get(path)!;
		// Already reported as too big above; not read.
		if (entry.bytes > MAX_FILE_BYTES) continue;
		const text = read(path);
		let json: unknown;
		let valid = false;
		try {
			if (text !== null) {
				json = JSON.parse(text);
				valid = VALIDATORS[where.kind](json).valid;
			}
		} catch {
			valid = false;
		}
		// A file in the wrong place would be served as something it is not.
		if (valid && where.date !== undefined) {
			const body = json as { pullDate?: unknown; file?: unknown };
			if (where.kind !== 'changes' && body.pullDate !== where.date) valid = false;
			if (where.kind === 'region' && body.file !== where.name) valid = false;
		}
		if (valid) parsed.set(path, json);
		else problems.push(`E_INVALID:${path}`);
	}

	checkIndex(files, dates, parsed, placed, problems);
	return problems;
}

/** The index is the app's first read: everything it names must be there, whole, for its pull date. */
function checkIndex(
	files: Map<string, TreeEntry>,
	dates: Set<string>,
	parsed: Map<string, unknown>,
	placed: Map<string, Placed>,
	problems: string[]
): void {
	const indexPath = `${DEPLOY_DATA_DIR}/index.json`;
	if (!placed.has(indexPath)) {
		problems.push('E_INDEX');
		return;
	}
	const index = parsed.get(indexPath) as IndexFile | undefined;
	if (index === undefined) {
		problems.push('E_INDEX');
		return;
	}
	if (!dates.has(index.pullDate)) {
		problems.push('E_MISSING_WEEK');
		return;
	}
	const weekDir = `${DATA_WEEK_ROOT}/${index.pullDate}`;
	for (const named of index.files) {
		const path = `${weekDir}/${named.name}.json`;
		const entry = files.get(path);
		if (entry === undefined) {
			problems.push(`E_MISSING_FILE:${path}`);
			continue;
		}
		if (entry.bytes !== named.bytes) problems.push(`E_BYTES:${path}`);
		const region = parsed.get(path) as { listings: unknown[] } | undefined;
		if (region !== undefined && region.listings.length !== named.count)
			problems.push(`E_COUNT:${path}`);
	}
	for (const name of ['ids', 'changes']) {
		const path = `${weekDir}/${name}.json`;
		if (!files.has(path)) problems.push(`E_MISSING_FILE:${path}`);
	}
}

/**
 * Checks the config and the tree, and only when both are clean runs wrangler from the data Worker's own folder
 * with its own config. Refuses to start from the app's root, where the app's own Worker config lives.
 */
export async function guardAndDeploy(
	deps: GuardDeps,
	options: { configPath: string }
): Promise<{ ok: boolean; problems: string[]; exitCode?: number }> {
	const problems: string[] = [];
	if (sameKey(deps.cwd) === sameKey(deps.repoRoot)) problems.push('E_APP_ROOT');
	const setNames = Object.keys(deps.env).filter((name) => {
		const value = deps.env[name];
		const upper = name.toUpperCase();
		return (
			value !== undefined && value !== '' && FORBIDDEN_ENV_PREFIXES.some((p) => upper.startsWith(p))
		);
	});
	for (const name of setNames.sort()) problems.push(`E_ENV:${name}`);
	for (const name of DOTENV_FILES) {
		if (deps.exists(`${workerFolder(deps.repoRoot)}/${name}`)) problems.push(`E_DOTENV:${name}`);
	}
	problems.push(...checkConfig(options.configPath, deps));
	problems.push(...checkTree(`${workerFolder(deps.repoRoot)}/deploy`, deps));
	if (problems.length > 0) return { ok: false, problems };

	try {
		const exitCode = await deps.runner(
			deps.nodePath,
			[deps.wranglerJs, 'deploy', '--config', dataConfigPath(deps.repoRoot)],
			{ cwd: workerFolder(deps.repoRoot) }
		);
		return { ok: exitCode === 0, problems: [], exitCode };
	} catch {
		return { ok: false, problems: ['E_RUNNER'] };
	}
}
