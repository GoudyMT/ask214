/**
 * Downloads the published SkillBridge files. This part is handed file names only - never a place, a search or
 * any other personal value - so what reaches the network is one fixed path per request and nothing else. Every
 * file is read under a size cap and checked against the contract before it is returned; a file that fails is
 * dropped, never trusted or kept.
 */

import {
	MAX_FILE_BYTES,
	type ChangesFile,
	type IdsFile,
	type IndexFile,
	type RegionFile
} from '../contract/listing';
import {
	REGION_FILE_NAMES,
	dataPath,
	type DataFile,
	type RegionFileName,
	type TableFileName
} from '../contract/places';
import {
	validateZips,
	validateCrosswalk,
	type CrosswalkTable,
	type ZipsTable
} from '../contract/tables';
import {
	validateChanges,
	validateIds,
	validateIndex,
	validateRegionFile,
	type ContractResult
} from '../contract/validate';
import { readCapped } from './read-capped';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** Region files requested at once; a person on a slow phone link gains nothing from more. */
const MAX_IN_FLIGHT = 3;

// Nothing that identifies the person rides along: no cookie, no referrer, no header, no redirect to follow.
const REQUEST_INIT: RequestInit = {
	cache: 'no-store',
	credentials: 'omit',
	redirect: 'error',
	referrerPolicy: 'no-referrer',
	mode: 'same-origin'
};

const defaultFetch: FetchFn = (input, init) => globalThis.fetch(input, init);

/** The one place a request is made: the URL comes from dataPath alone, and the body is capped, decoded, parsed. */
async function getJson(
	file: DataFile,
	fetchFn: FetchFn,
	maxBytes: number = MAX_FILE_BYTES
): Promise<unknown> {
	const response = await fetchFn(dataPath(file), REQUEST_INIT);
	if (!response.ok) throw new Error('E_SBF_HTTP');
	const bytes = await readCapped(response, maxBytes);

	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new Error('E_SBF_BAD_ENCODING');
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error('E_SBF_BAD_JSON');
	}
}

function checked<T>(raw: unknown, result: ContractResult): T {
	if (!result.valid) throw new Error('E_SBF_INVALID');
	return raw as T;
}

/** The furthest an index may be dated past the device's own UTC day: a pull a few days early, never a far-off one. */
export const MAX_DAYS_AHEAD = 7;
const MS_PER_DAY = 86_400_000;

/** `now` is the device clock in ms; it is only read to refuse a pull date that cannot be true. */
export async function fetchIndex(
	fetchFn: FetchFn = defaultFetch,
	now: () => number = Date.now
): Promise<IndexFile> {
	const raw = await getJson({ kind: 'index' }, fetchFn);
	const index = checked<IndexFile>(raw, validateIndex(raw));
	const pullDay = Date.parse(`${index.pullDate}T00:00:00Z`) / MS_PER_DAY;
	if (pullDay - Math.floor(now() / MS_PER_DAY) > MAX_DAYS_AHEAD) throw new Error('E_SBF_INVALID');
	return index;
}

/**
 * The listed region files among `names`, requested in the fixed file order whatever order `names` has. A name the
 * index does not list is not requested. A file that cannot be fetched or read, fails the contract, is from another
 * pull than the index, names another file, or is larger than the index says it is, is dropped.
 */
export async function fetchRegionFiles(
	index: IndexFile,
	names: readonly RegionFileName[],
	fetchFn: FetchFn = defaultFetch
): Promise<{ files: Map<RegionFileName, RegionFile>; dropped: RegionFileName[] }> {
	const declared = new Map<string, number>(index.files.map((f) => [f.name, f.bytes]));
	const fixedOrder: readonly string[] = REGION_FILE_NAMES;
	// A name off the fixed list sorts first, so the check below still throws before the first request.
	const wanted = [...new Set(names)]
		.filter((name) => declared.has(name))
		.sort((a, b) => fixedOrder.indexOf(a) - fixedOrder.indexOf(b));
	const fileOf = (name: RegionFileName): DataFile => ({
		kind: 'region',
		pullDate: index.pullDate,
		name
	});
	// A name off the fixed lists is a bug, not a bad network: it throws here, before the first request.
	for (const name of wanted) dataPath(fileOf(name));

	const loaded = new Map<RegionFileName, RegionFile | null>();
	let next = 0;
	const worker = async () => {
		while (next < wanted.length) {
			const name = wanted[next++] as RegionFileName;
			try {
				// Also bounds the whole download to what the index declares, not the global cap per file.
				const limit = Math.min(MAX_FILE_BYTES, declared.get(name) ?? 0);
				const raw = await getJson(fileOf(name), fetchFn, limit);
				const file = raw as RegionFile;
				const ok =
					validateRegionFile(raw).valid && file.pullDate === index.pullDate && file.file === name;
				loaded.set(name, ok ? file : null);
			} catch {
				loaded.set(name, null);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, wanted.length) }, worker));

	// Reported in the fixed file order, whichever request finished first.
	const files = new Map<RegionFileName, RegionFile>();
	const dropped: RegionFileName[] = [];
	for (const name of wanted) {
		const file = loaded.get(name);
		if (file) files.set(name, file);
		else dropped.push(name);
	}
	return { files, dropped };
}

/**
 * The ids or changes file of the index's own week. The date in the request is the index's, so no caller (and no
 * date held on the device) can choose it.
 */
export async function fetchWeekFile<K extends 'ids' | 'changes'>(
	index: IndexFile,
	kind: K,
	fetchFn: FetchFn = defaultFetch
): Promise<K extends 'ids' ? IdsFile : ChangesFile> {
	type Value = K extends 'ids' ? IdsFile : ChangesFile;
	const raw = await getJson({ kind, pullDate: index.pullDate }, fetchFn);
	if (kind === 'ids') {
		const ids = checked<IdsFile>(raw, validateIds(raw));
		// A copy from another pull, served at this pull's path, would pass as current.
		if (ids.pullDate !== index.pullDate) throw new Error('E_SBF_INVALID');
		return ids as Value;
	}
	const changes = checked<ChangesFile>(raw, validateChanges(raw));
	// The newest week it describes is the pull it was published for.
	if (changes.weeks[0]?.pullDate !== index.pullDate) throw new Error('E_SBF_INVALID');
	return changes as Value;
}

type TableFile = Extract<DataFile, { kind: 'table' }>;
type TableValues = { zips: ZipsTable; crosswalk: CrosswalkTable };

const TABLE_VALIDATORS: Record<TableFileName, (raw: unknown) => ContractResult> = {
	zips: validateZips,
	crosswalk: validateCrosswalk
};

/** A supporting table, returned only when it passes its own validator. */
export async function fetchDataFile<F extends TableFile>(
	file: F,
	fetchFn: FetchFn = defaultFetch
): Promise<TableValues[F['name']]> {
	// Ids and changes files go through fetchWeekFile; refused before any request, even through a cast.
	if (file.kind !== 'table') throw new Error('E_SBF_BAD_PATH');
	const raw = await getJson(file, fetchFn);
	return checked(raw, TABLE_VALIDATORS[file.name](raw));
}
