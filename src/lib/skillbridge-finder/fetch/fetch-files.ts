/**
 * Downloads the published SkillBridge files. This part is handed file names only - never a place, a search or
 * any other personal value - so what reaches the network is one fixed path per request and nothing else. Every
 * file is read under a size cap and checked against the contract before it is returned; a file that fails is
 * dropped, never trusted or kept.
 */

import type { ChangesFile, IdsFile, IndexFile, RegionFile } from '../contract/listing';
import {
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
async function getJson(file: DataFile, fetchFn: FetchFn): Promise<unknown> {
	const response = await fetchFn(dataPath(file), REQUEST_INIT);
	if (!response.ok) throw new Error('E_SBF_HTTP');
	const bytes = await readCapped(response);

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
const MAX_DAYS_AHEAD = 7;
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
 * The listed region files among `names`. A name the index does not list is not requested. A file that cannot be
 * fetched or read, fails the contract, is from another pull than the index, or names another file is dropped.
 */
export async function fetchRegionFiles(
	index: IndexFile,
	names: readonly RegionFileName[],
	fetchFn: FetchFn = defaultFetch
): Promise<{ files: Map<RegionFileName, RegionFile>; dropped: RegionFileName[] }> {
	const listed = new Set<string>(index.files.map((f) => f.name));
	const wanted = [...new Set(names)].filter((name) => listed.has(name));
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
				const raw = await getJson(fileOf(name), fetchFn);
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

	// Reported in the order asked for, whichever request finished first.
	const files = new Map<RegionFileName, RegionFile>();
	const dropped: RegionFileName[] = [];
	for (const name of wanted) {
		const file = loaded.get(name);
		if (file) files.set(name, file);
		else dropped.push(name);
	}
	return { files, dropped };
}

type OtherFile = Extract<DataFile, { kind: 'ids' | 'changes' | 'table' }>;
type TableValues = { zips: ZipsTable; crosswalk: CrosswalkTable };
type ValueOf<F extends OtherFile> = F extends { kind: 'ids' }
	? IdsFile
	: F extends { kind: 'changes' }
		? ChangesFile
		: F extends { kind: 'table'; name: infer N extends TableFileName }
			? TableValues[N]
			: never;

const TABLE_VALIDATORS: Record<TableFileName, (raw: unknown) => ContractResult> = {
	zips: validateZips,
	crosswalk: validateCrosswalk
};

/** An ids, changes or table file, returned only when it passes its own validator. */
export async function fetchDataFile<F extends OtherFile>(
	file: F,
	fetchFn: FetchFn = defaultFetch
): Promise<ValueOf<F>> {
	const raw = await getJson(file, fetchFn);
	switch (file.kind) {
		case 'ids': {
			const ids = checked<IdsFile>(raw, validateIds(raw));
			// A copy from another pull, served at this pull's path, would pass as current.
			if (ids.pullDate !== file.pullDate) throw new Error('E_SBF_INVALID');
			return ids as ValueOf<F>;
		}
		case 'changes': {
			const changes = checked<ChangesFile>(raw, validateChanges(raw));
			// The newest week it describes is the pull it was published for.
			if (changes.weeks[0]?.pullDate !== file.pullDate) throw new Error('E_SBF_INVALID');
			return changes as ValueOf<F>;
		}
		case 'table':
			return checked(raw, TABLE_VALIDATORS[file.name](raw));
		default:
			throw new Error('E_SBF_BAD_PATH');
	}
}
