/**
 * Turns the checked week into the exact static files the app fetches, and writes them so a phone never reads a
 * half-written week. `buildWeek` is pure (it builds every body and checks each against the app's own validators
 * before anything is written); `writeDeployTree` does the writing through an injected file system.
 */

import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import {
	MAX_CHANGE_WEEKS,
	MAX_FILE_BYTES,
	MAX_LISTINGS_PER_FILE
} from '../../src/lib/skillbridge-finder/contract/listing.ts';
import type {
	ChangesFile,
	IdsFile,
	IndexFile,
	Listing,
	RegionFile
} from '../../src/lib/skillbridge-finder/contract/listing.ts';
import { DELIVERY } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import {
	DIVISION_OF_STATE,
	REGION_FILE_NAMES,
	TABLE_FILE_NAMES,
	TERRITORY_CODES,
	dataPath,
	isIsoDate
} from '../../src/lib/skillbridge-finder/contract/places.ts';
import type {
	RegionFileName,
	StateCode,
	TableFileName
} from '../../src/lib/skillbridge-finder/contract/places.ts';
import {
	validateBases,
	validateCrosswalk,
	validateZips
} from '../../src/lib/skillbridge-finder/contract/tables.ts';
import {
	validateChanges,
	validateIds,
	validateIndex,
	validateRegionFile
} from '../../src/lib/skillbridge-finder/contract/validate.ts';
import type { ContractResult } from '../../src/lib/skillbridge-finder/contract/validate.ts';
import { DATA_HEADERS_FILE, DEPLOY_DATA_DIR, DEPLOY_WEEKS_KEPT } from './config.ts';

/** A listing naming this many states or more is in `multi-state` only: it fits no one division. */
const MULTI_STATE_MIN = 10;

const TABLE_VALIDATORS: Record<TableFileName, (raw: unknown) => ContractResult> = {
	zips: validateZips,
	bases: validateBases,
	crosswalk: validateCrosswalk
};

/** Every file a listing belongs in, in `REGION_FILE_NAMES` order, and no other. */
export function placeListing(listing: Listing, overseas: ReadonlySet<number>): RegionFileName[] {
	if (listing.m === DELIVERY.remote) return ['remote'];
	if (overseas.has(listing.i)) return ['overseas'];
	if ((listing.ls?.length ?? 0) >= MULTI_STATE_MIN) return ['multi-state'];

	const states = new Set<StateCode>(listing.ls ?? []);
	if (listing.s !== undefined) states.add(listing.s);
	if (states.size === 0) return ['unknown'];

	const files = new Set<RegionFileName>();
	for (const code of states) {
		// A code with no division is never dropped: it goes where a person can still find it.
		if (TERRITORY_CODES.includes(code)) files.add('territories');
		else files.add(DIVISION_OF_STATE[code] ?? 'unknown');
	}
	return REGION_FILE_NAMES.filter((name) => files.has(name));
}

/** A file to write, its path relative to the deploy root with `/` separators. */
export type BuiltFile = { path: string; body: string };
export type BuiltWeek = { files: BuiltFile[]; index: IndexFile; errors: string[] };

const byId = (a: Listing, b: Listing) => a.i - b.i;
const bytesOf = (body: string) => Buffer.byteLength(body, 'utf8');

export function buildWeek(input: {
	pullDate: string;
	baseline: boolean;
	baselineDate: string;
	published: readonly Listing[];
	overseas: ReadonlySet<number>;
	aliases: readonly [number, number][];
	/** This week's change week, then last week's when there is one. */
	weeks: ChangesFile['weeks'];
	/** Parsed tables to publish whole; each is validated. */
	tables: Partial<Record<TableFileName, unknown>>;
}): BuiltWeek {
	const { pullDate, baseline, baselineDate, published, overseas, aliases, weeks, tables } = input;
	const index: IndexFile = { v: 1, pullDate, baseline, baselineDate, files: [] };
	// A bad date would put a file at a path no client asks for, so nothing is built from it.
	if (!isIsoDate(pullDate) || !isIsoDate(baselineDate))
		return { files: [], index, errors: ['E_BAD_DATE'] };

	const errors = new Set<string>();
	const files: BuiltFile[] = [{ path: '_headers', body: DATA_HEADERS_FILE }];
	const note = (path: string, body: string) => {
		files.push({ path, body });
		if (bytesOf(body) > MAX_FILE_BYTES) errors.add('E_FILE_TOO_BIG');
	};

	const sorted = [...published].sort(byId);
	const buckets = new Map<RegionFileName, Listing[]>(REGION_FILE_NAMES.map((name) => [name, []]));
	for (const listing of sorted)
		for (const name of placeListing(listing, overseas)) buckets.get(name)?.push(listing);

	for (const name of REGION_FILE_NAMES) {
		const listings = buckets.get(name) ?? [];
		if (name === 'overseas' && listings.length === 0) continue;
		const region: RegionFile = { v: 1, pullDate, file: name, listings };
		const body = JSON.stringify(region);
		note(dataPath({ kind: 'region', pullDate, name }).slice(1), body);
		index.files.push({ name, count: listings.length, bytes: bytesOf(body) });
		if (listings.length > MAX_LISTINGS_PER_FILE) errors.add('E_TOO_MANY_LISTINGS');
		else if (!validateRegionFile(region).valid) errors.add('E_INVALID_REGION');
	}

	// An alias is kept only when its target is published and its source is not, as the contract requires.
	const ids = new Set(sorted.map((l) => l.i));
	const idsFile: IdsFile = {
		v: 1,
		pullDate,
		ids: sorted.map((l) => [l.i, l.fl]),
		aliases: aliases
			.filter(([from, to]) => ids.has(to) && !ids.has(from))
			.map(([from, to]): [number, number] => [from, to])
			.sort((a, b) => a[0] - b[0] || a[1] - b[1])
	};
	note(dataPath({ kind: 'ids', pullDate }).slice(1), JSON.stringify(idsFile));
	if (!validateIds(idsFile).valid) errors.add('E_INVALID_IDS');

	const changes: ChangesFile = { v: 1, weeks: weeks.slice(0, MAX_CHANGE_WEEKS) };
	note(dataPath({ kind: 'changes', pullDate }).slice(1), JSON.stringify(changes));
	if (!validateChanges(changes).valid) errors.add('E_INVALID_CHANGES');

	for (const name of TABLE_FILE_NAMES) {
		const table = tables[name];
		if (table === undefined) continue;
		note(dataPath({ kind: 'table', name }).slice(1), JSON.stringify(table));
		if (!TABLE_VALIDATORS[name](table).valid) errors.add('E_INVALID_TABLE');
	}

	if (!validateIndex(index).valid) errors.add('E_INVALID_INDEX');
	note(dataPath({ kind: 'index' }).slice(1), JSON.stringify(index));

	return { files, index, errors: [...errors] };
}

/** The few file-system calls the writer needs, so a test can record them and never touch a real disk. */
export type TreeFs = {
	exists(path: string): boolean;
	/** Recursive. */
	mkdir(path: string): void;
	writeFile(path: string, body: string): void;
	rename(from: string, to: string): void;
	listDir(path: string): string[];
	isDirectory(path: string): boolean;
	/** Recursive. */
	removeDir(path: string): void;
};

export const nodeTreeFs: TreeFs = {
	exists: (path) => {
		try {
			lstatSync(path);
			return true;
		} catch {
			return false;
		}
	},
	mkdir: (path) => {
		mkdirSync(path, { recursive: true });
	},
	writeFile: (path, body) => {
		writeFileSync(path, body, 'utf8');
	},
	rename: (from, to) => {
		renameSync(from, to);
	},
	listDir: (path) => readdirSync(path),
	// lstat, so a link to a folder is not followed and is never taken for a dated folder.
	isDirectory: (path) => lstatSync(path).isDirectory(),
	removeDir: (path) => {
		rmSync(path, { recursive: true });
	}
};

const TRAILING_SEPARATORS = /[\\/]+$/;
const SEPARATOR = /[\\/]/;

const TEMPORARY_SUFFIX = '.tmp';

/**
 * A prune removes only a dated folder sitting directly in the weeks folder; a temporary twin, a stray name or a
 * path that climbs out is a bug, not a prune.
 */
export function assertDirectChild(weeksDir: string, path: string): void {
	const name = path.startsWith(`${weeksDir}/`) ? path.slice(weeksDir.length + 1) : '';
	if (!isIsoDate(name) || SEPARATOR.test(name)) throw new Error('E_UNSAFE_PRUNE');
}

/**
 * Writes the week into the deploy folder. The dated folder is written complete beside its final name and swapped
 * in, then `index.json` is swapped in last, so a phone reading `index.json` sees last week's complete set or this
 * week's, never a mix. Older dated folders are pruned only after that; a name that is not a date is left alone.
 */
export function writeDeployTree(
	deployRoot: string,
	week: BuiltWeek,
	fs: TreeFs
): { pruned: string[]; kept: string[]; ignored: string[] } {
	if (week.errors.length > 0) throw new Error('E_WEEK_HAS_ERRORS');
	// The pull date names folders that are removed below, so it is checked before anything is written.
	const pullDate = week.index.pullDate;
	if (!isIsoDate(pullDate)) throw new Error('E_BAD_DATE');

	const root = deployRoot.replace(TRAILING_SEPARATORS, '');
	const at = (relative: string) => `${root}/${relative}`;
	const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
	const weeksDir = at(`${DEPLOY_DATA_DIR}/w`);
	const datedPrefix = `${DEPLOY_DATA_DIR}/w/${pullDate}/`;
	const indexPath = `${DEPLOY_DATA_DIR}/index.json`;
	const finalDir = `${weeksDir}/${pullDate}`;
	// The dated folder is checked as the prune checks it; its temporary twin is that path plus a fixed suffix,
	// so it sits beside it by construction.
	assertDirectChild(weeksDir, finalDir);
	const tmpDir = `${finalDir}${TEMPORARY_SUFFIX}`;

	fs.mkdir(root);
	for (const file of week.files.filter((f) => f.path === '_headers'))
		fs.writeFile(at(file.path), file.body);

	// A leftover temporary folder of this very date is a run that died part-way: start it afresh.
	if (fs.exists(tmpDir)) fs.removeDir(tmpDir);
	fs.mkdir(tmpDir);
	for (const file of week.files.filter((f) => f.path.startsWith(datedPrefix)))
		fs.writeFile(`${tmpDir}/${file.path.slice(datedPrefix.length)}`, file.body);
	// A folder cannot be renamed over another on Windows, so the old one goes first.
	if (fs.exists(finalDir)) fs.removeDir(finalDir);
	fs.rename(tmpDir, finalDir);

	const others = week.files.filter(
		(f) => f.path !== '_headers' && f.path !== indexPath && !f.path.startsWith(datedPrefix)
	);
	for (const file of others) {
		fs.mkdir(parentOf(at(file.path)));
		fs.writeFile(at(file.path), file.body);
	}

	fs.mkdir(at(DEPLOY_DATA_DIR));
	for (const file of week.files.filter((f) => f.path === indexPath)) {
		fs.writeFile(`${at(file.path)}.tmp`, file.body);
		fs.rename(`${at(file.path)}.tmp`, at(file.path));
	}

	const dated: string[] = [];
	const ignored: string[] = [];
	for (const name of fs.listDir(weeksDir)) {
		if (isIsoDate(name) && fs.isDirectory(`${weeksDir}/${name}`)) dated.push(name);
		else ignored.push(name);
	}
	// The folder just written is always kept: `index.json` points at it, whatever dates are already there.
	const newestOthers = dated
		.filter((d) => d !== pullDate)
		.sort()
		.reverse()
		.slice(0, DEPLOY_WEEKS_KEPT - 1);
	const kept = [pullDate, ...newestOthers].sort();
	const pruned = dated.filter((d) => !kept.includes(d)).sort();
	for (const name of pruned) {
		assertDirectChild(weeksDir, `${weeksDir}/${name}`);
		fs.removeDir(`${weeksDir}/${name}`);
	}
	return { pruned, kept, ignored: ignored.sort() };
}
