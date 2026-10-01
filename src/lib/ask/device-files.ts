import { ASK_ASSET_CACHE, CORPUS_BASE, SET_UP_FILES } from './asset-cache';

// The lookup takes milliseconds; a browser whose Cache API never answers must not hold the Ask up past this.
const LOOKUP_LIMIT_MS = 2_000;

/**
 * Every file an on-device answer needs from the asset cache, as the service worker keeps them: the search model, the
 * runtime that runs it, and the answer library. The model and runtime paths are the service worker's own list of what
 * a finished setup holds (`SET_UP_FILES`), so the page and the worker cannot disagree about it; they are written out
 * there rather than read from the vendored manifest, so the page does not carry the manifest's hashes. Tests hold
 * this list to the manifest, to the files the app ships, and - end to end - to exactly what a real setup stores.
 *
 * The embed worker's own script is needed too, but it is not in this list: the service worker keeps it in the
 * release's cache (and the browser's HTTP cache usually holds it as well), not in the asset cache this list is
 * read from.
 */
export const DEVICE_FILES: readonly string[] = [
	...SET_UP_FILES,
	`${CORPUS_BASE}.json`,
	`${CORPUS_BASE}.embeddings.bin`
];

/**
 * Whether this device keeps every file an on-device answer needs, read from the cache itself.
 *
 * A remembered "downloaded" flag drifted from the cache: a download made before the service worker took charge, a
 * write that failed on a full disk, and files the browser later deleted all left it claiming a model that was not
 * there - and the next question downloaded the model again without asking. The cache is the fact.
 *
 * @param cachesApi The browser's CacheStorage; undefined where it has none.
 * @param timeoutMs How long to wait for the cache before answering "not kept", which asks before downloading.
 * @returns true only when every file is kept; false otherwise, including when the cache cannot be read in time.
 */
export function deviceFilesKept(
	cachesApi: CacheStorage | undefined,
	timeoutMs = LOOKUP_LIMIT_MS
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
	});
	return Promise.race([allKept(cachesApi), limit]).finally(() => clearTimeout(timer));
}

async function allKept(cachesApi: CacheStorage | undefined): Promise<boolean> {
	try {
		if (cachesApi === undefined) return false;
		for (const path of DEVICE_FILES) {
			// cacheName looks in the asset cache alone, and a missing cache reads as missing - never created.
			const options = { cacheName: ASK_ASSET_CACHE, ignoreVary: true };
			if ((await cachesApi.match(path, options)) === undefined) return false;
		}
		return true;
	} catch {
		// A cache the browser will not open (a private mode, a storage error) keeps nothing to count on.
		return false;
	}
}
