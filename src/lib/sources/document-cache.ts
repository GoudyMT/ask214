import { ASK_ASSET_CACHE, CORPUS_BASE } from '$lib/ask/asset-cache';
import { LIBRARY_SRC, WORKER_SRC } from './pdf-library-paths';

/**
 * Whether a served document is already held on this device.
 *
 * The reader asks before a document's first download and goes straight to the text when it is offline with
 * nothing saved, so it needs to know before it tries. Only the user's save stores a document, in the asset
 * cache, so that cache is the one place to look.
 *
 * The lookup ignores Vary, so a held copy is found by its path alone, whatever headers the request that
 * stored it carried. A copy that read as absent while it is held would have the reader ask to download a
 * document the user already has.
 *
 * Every failure answers "not saved" - no Cache API (some private windows), a cache that will not open, a
 * lookup that throws. That is the safe direction: the reader asks rather than promising an offline copy.
 *
 * @param path The document's served path, as `localDocumentPath` returns it.
 * @param cachesApi The Cache API; injected by tests, the browser's own by default.
 * @returns True when the document is held.
 */
export async function isDocumentSaved(
	path: string,
	cachesApi: CacheStorage | undefined = globalThis.caches
): Promise<boolean> {
	if (cachesApi === undefined) return false;
	try {
		const cache = await cachesApi.open(ASK_ASSET_CACHE);
		return (await cache.match(path, { ignoreVary: true })) !== undefined;
	} catch {
		return false;
	}
}

/**
 * The served documents held on this device, as the paths the reader requests them by.
 *
 * Checks that the cache exists before opening it, because opening creates it: a read must not leave an empty
 * cache behind on a device that never saved anything. Every failure lists nothing - the area then offers to
 * save documents that may already be held, which a save simply refreshes.
 *
 * @param cachesApi The Cache API; injected by tests, the browser's own by default.
 * @param origin This app's origin; only its own entries are documents it served.
 * @returns The held `/docs/` pathnames.
 */
export async function listCachedDocuments(
	cachesApi: CacheStorage | undefined = globalThis.caches,
	origin: string = globalThis.location.origin
): Promise<string[]> {
	try {
		const cache = await existingCache(cachesApi);
		const paths: string[] = [];
		for (const request of (await cache?.keys()) ?? []) {
			const url = new URL(request.url);
			if (url.origin === origin && url.pathname.startsWith('/docs/')) paths.push(url.pathname);
		}
		return paths;
	} catch {
		return [];
	}
}

/**
 * Whether the answer library - the corpus Ask searches on the device - is held on this device, so a document's
 * text opens without a connection. It is two files, and the text needs both.
 *
 * @param base The library's path without its extension, as the app loads it (`CORPUS_BASE`).
 * @param cachesApi The Cache API; injected by tests, the browser's own by default.
 * @returns True when both library files are held.
 */
export function isAnswerLibraryHeld(
	base: string,
	cachesApi: CacheStorage | undefined = globalThis.caches
): Promise<boolean> {
	return allHeld([`${base}.json`, `${base}.embeddings.bin`], cachesApi);
}

/**
 * Whether the page reader - the PDF library and its worker - is held on this device. A save stores it before
 * its first document, so the Save area says what a first save also downloads while it is missing.
 *
 * @param cachesApi The Cache API; injected by tests, the browser's own by default.
 * @returns True when both files are held.
 */
export function isPdfLibraryHeld(
	cachesApi: CacheStorage | undefined = globalThis.caches
): Promise<boolean> {
	return allHeld([LIBRARY_SRC, WORKER_SRC], cachesApi);
}

// Checks that the cache exists before opening it, as `listCachedDocuments` does, and ignores Vary for the reason
// `isDocumentSaved` does. Every failure answers no, so the app promises nothing it cannot keep.
async function allHeld(
	files: readonly string[],
	cachesApi: CacheStorage | undefined
): Promise<boolean> {
	try {
		const cache = await existingCache(cachesApi);
		for (const file of files) {
			if ((await cache?.match(file, { ignoreVary: true })) === undefined) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * The bytes this device holds for the given paths - the older copies an update left behind.
 *
 * Read from the stored files themselves: an older copy is a version this build no longer ships, so no size table
 * knows it, and a stored response need not carry its length. Checks that the cache exists before opening it, as
 * `listCachedDocuments` does. A path not held counts nothing. A read that fails makes the size unknown: the
 * Documents area then leaves the size out, and what Remove all frees, rather than stating a figure that is
 * wrong - 0.0 MB for a copy the device holds.
 *
 * @param paths The held paths to size.
 * @param cachesApi The Cache API; injected by tests, the browser's own by default.
 * @returns Their stored bytes, summed; null when any of them could not be read.
 */
export async function heldBytes(
	paths: readonly string[],
	cachesApi: CacheStorage | undefined = globalThis.caches
): Promise<number | null> {
	try {
		const cache = await existingCache(cachesApi);
		let total = 0;
		for (const path of paths) {
			const held = await cache?.match(path, { ignoreVary: true });
			if (held !== undefined) total += (await held.blob()).size;
		}
		return total;
	} catch {
		return null;
	}
}

/** How a save ended - each one a thing the Documents area can say. */
export type SaveResult = 'saved' | 'stopped' | 'offline' | 'quota' | 'failed';

// Every save still running, whichever part of the app started it, with the document it saves and a way to stop
// it. A download that has arrived is stored however the save is stopped, so clearing the saved documents waits
// for these rather than trusting a stop.
const inFlight = new Map<Promise<SaveResult>, { path: string; stop: () => void }>();

// Every save listens to this as well as to its caller's signal, so clearing the saved documents can stop them
// all - a document's own save from its row or the reader takes no signal of its own - rather than wait out a
// slow download. Replaced after each stop, so a save started later runs normally.
let stopEvery = new AbortController();

// How many times every save has been stopped. A run of saves reads it after each save: a save whose download
// had already arrived ends as saved even when stopped, and the run must still end there.
let stops = 0;

/**
 * Stop every save and wait until none can still store a document. Each save running - a document's own, or
 * the current one of a run of saves - ends as `stopped`, so a slow or stalled download cannot hold the caller
 * back; a write that had already begun is waited out. A run of saves ends at its current save, stopped or
 * stored, so nothing further starts. Clearing the saved documents calls this first, or a save still writing
 * would put its document back after the clear. A save started afterwards is not affected.
 *
 * @returns A promise that resolves once no save is running.
 */
export async function stopSaves(): Promise<void> {
	stops += 1;
	stopEvery.abort();
	stopEvery = new AbortController();
	await savesSettled();
}

/**
 * How many times every save has been stopped; a run compares it before and after each save.
 *
 * @returns The count.
 */
export function stopCount(): number {
	return stops;
}

/**
 * Stop the saves of one document and wait until none of them can still store it. Removing a document calls
 * this first, or its own save still writing would put it straight back.
 *
 * @param path The document's served path.
 * @returns A promise that resolves once no save of that document is running.
 */
export async function stopSave(path: string): Promise<void> {
	const running = [...inFlight].filter(([, save]) => save.path === path);
	for (const [, save] of running) save.stop();
	await Promise.allSettled(running.map(([run]) => run));
}

/**
 * A document's save still running, whichever part of the app started it. A Save built while its document saves -
 * the reader's foot built again in its other place, or the Documents list once the reader closes - shows this
 * save rather than offering a second download.
 *
 * @param path The document's served path.
 * @returns The running save, resolving with how it ended; undefined when none is running.
 */
export function runningSave(path: string): Promise<SaveResult> | undefined {
	return [...inFlight].find(([, save]) => save.path === path)?.[0];
}

/**
 * Resolves once every save running at the time of the call has ended, stored or not. Never rejects.
 *
 * @returns A promise that resolves when those saves have settled.
 */
export async function savesSettled(): Promise<void> {
	await Promise.allSettled([...inFlight.keys()]);
}

/**
 * Save a served document on this device, with the PDF library that draws its pages, then clear its older
 * copies.
 *
 * Only this save stores a document: the service worker passes a viewed one through without keeping it. The
 * page writes each file itself and waits for the write, so a full disk reaches the user.
 *
 * The library comes first, and only the files of it not already held: it is shared by every document, so a
 * run of saves downloads it once. Without it a saved document opens offline only as its text, and nothing
 * else stores it unless a reader opens a document online. The answer library comes next, the same way: it
 * holds the text of every source, which the Text view shows and a screen reader reads, so without it a saved
 * document offline has pages and no text. A file of either that cannot be stored ends the save the way a
 * failed document does, before the document is requested.
 *
 * Each file is fetched whole: the service worker hands a stored copy to any later request for its url, so
 * it must be the whole 200, and a cached whole file handed to a byte-range read corrupts it.
 *
 * Older copies are deleted only AFTER the new one is stored. Until then an older copy is still the user's
 * record of the document, and a failed save must not cost them it.
 *
 * With the worker in control a lost connection does not reject the fetch - the worker answers 503 itself -
 * so any failure while the device reports no connection is read as offline.
 *
 * The save counts as running, for `savesSettled`, from the call until it ends, and `stopSaves` stops it as its
 * own signal would.
 *
 * @param path The document's current served path.
 * @param stale Held older copies of the same document.
 * @param options `signal` stops the save; `library` is what a saved document needs besides itself - by default
 *   the PDF library's pair the reader loads, then the answer library's pair the Text view loads; the rest are
 *   the browser's own by default. All but `signal` are injected by tests.
 * @returns How the save ended. Never throws.
 */
export async function saveDocument(
	path: string,
	stale: readonly string[],
	options: SaveOptions = {}
): Promise<SaveResult> {
	const own = new AbortController();
	const stop = () => own.abort();
	const every = stopEvery.signal;
	every.addEventListener('abort', stop, { once: true });
	options.signal?.addEventListener('abort', stop, { once: true });
	if (options.signal?.aborted) stop();
	const run = storeDocument(path, stale, { ...options, signal: own.signal });
	inFlight.set(run, { path, stop });
	try {
		return await run;
	} finally {
		inFlight.delete(run);
		every.removeEventListener('abort', stop);
		options.signal?.removeEventListener('abort', stop);
	}
}

type SaveOptions = {
	fetchFn?: (path: string, init?: RequestInit) => Promise<Response>;
	cachesApi?: CacheStorage | undefined;
	signal?: AbortSignal;
	isOnline?: () => boolean;
	library?: readonly string[];
};

// The save itself, as `saveDocument` describes it.
async function storeDocument(
	path: string,
	stale: readonly string[],
	{
		fetchFn = globalThis.fetch,
		cachesApi = globalThis.caches,
		signal,
		isOnline = () => navigator.onLine,
		library = [LIBRARY_SRC, WORKER_SRC, `${CORPUS_BASE}.json`, `${CORPUS_BASE}.embeddings.bin`]
	}: SaveOptions
): Promise<SaveResult> {
	if (cachesApi === undefined) return 'failed';
	try {
		const cache = await cachesApi.open(ASK_ASSET_CACHE);
		const missing: string[] = [];
		for (const file of library) {
			// Ignores Vary: the worker keeps the library under its own request when a reader opens a document.
			if ((await cache.match(file, { ignoreVary: true })) === undefined) missing.push(file);
		}
		for (const file of [...missing, path]) {
			const response = await fetchFn(file, signal ? { signal } : {});
			if (response.status !== 200) return isOnline() ? 'failed' : 'offline';
			await cache.put(file, response);
		}
		await deleteEach(cache, stale);
		return 'saved';
	} catch (error) {
		if (signal?.aborted) return 'stopped';
		if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'quota';
		if (error instanceof TypeError || !isOnline()) return 'offline';
		return 'failed';
	}
}

/**
 * Remove documents from this device.
 *
 * Never throws: the Documents area reads the cache again after every change, so a delete that failed shows
 * as a document still saved rather than as an error.
 *
 * @param paths The held paths to delete, current and older copies alike.
 * @param cachesApi The Cache API; injected by tests, the browser's own by default.
 */
export async function removeDocuments(
	paths: readonly string[],
	cachesApi: CacheStorage | undefined = globalThis.caches
): Promise<void> {
	try {
		await deleteEach(await existingCache(cachesApi), paths);
	} catch {
		// Intentionally ignored - see above.
	}
}

// The asset cache, opened only when it exists: opening creates it, and a read must not leave an empty cache behind
// on a device that never saved anything. Undefined with no Cache API (some private windows) or no cache yet.
async function existingCache(cachesApi: CacheStorage | undefined): Promise<Cache | undefined> {
	if (cachesApi === undefined || !(await cachesApi.has(ASK_ASSET_CACHE))) return undefined;
	return cachesApi.open(ASK_ASSET_CACHE);
}

// Ignores Vary for the reason `isDocumentSaved` does, so a held copy is deleted by its path alone. One failed
// delete leaves that copy held and does not stop the rest. With no cache there is nothing to delete.
async function deleteEach(cache: Cache | undefined, paths: readonly string[]): Promise<void> {
	for (const path of paths) {
		try {
			await cache?.delete(path, { ignoreVary: true });
		} catch {
			// Intentionally ignored - the copy stays held, and the area shows it.
		}
	}
}
