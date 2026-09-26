/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';
import {
	classifyAsset,
	ASK_ASSET_CACHE,
	carryOverSavedDocuments,
	keptOnActivate,
	isSupersededVersionedEntry,
	isApiRequest,
	keptOnFetch,
	libraryToRestore,
	storeOnFetch
} from '$lib/ask/asset-cache';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `app-${version}`;
const ASSETS = [...build, ...files];
// Precache the app shell + small static assets at install; the heavy model/wasm (classifyAsset -> 'lazy')
// are EXCLUDED so install stays light + robust, and they cache on first /ask fetch instead.
const PRECACHE = ASSETS.filter((path) => classifyAsset(path) === 'precache');

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHE);
			// Install is when this release's files are known to be reachable - it is downloading them now - while
			// activation may come later with no connection. So a device holding saved documents gets this
			// release's PDF library here, and activation tries again for any file this could not store. The
			// restore never throws, so it cannot fail the install.
			await restoreLibraryForSavedDocuments(await caches.keys());
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// What the user saved moves into a renamed asset cache before the old one goes. A carry-over that
			// fails keeps every earlier asset cache rather than failing activation.
			const carried = await carryOverSavedDocuments(caches).catch(() => new Set<string>());
			const keys = await caches.keys();
			for (const key of keys) {
				// Keep the current app-shell cache + the lazy asset cache; drop stale app caches.
				if (!keptOnActivate(key, CACHE, carried)) await caches.delete(key);
			}
			await pruneSupersededVersions(keys);
			await sw.clients.claim();
			// The fallback for a library install could not store. Started after activation, not awaited inside
			// it: page requests wait while a worker activates, so a ~1.7 MB download here would stall every page
			// load after an update.
			void restoreLibraryForSavedDocuments(keys);
		})()
	);
});

/**
 * Delete what this build no longer ships from the lazy asset cache.
 *
 * The sweep above keeps ASK_ASSET_CACHE by name on every deploy, which is what protects the ~45MB model +
 * ORT WASM download. The corpus, the pdf library and the served documents live in that same cache but are
 * versioned by URL, so a rebuild adds the new filename and orphans the old one: without a per-entry prune
 * each deploy leaves bytes that nothing will ever request again. `isSupersededVersionedEntry` is given this
 * build's asset list, so the model, the WASM, and everything current never match - and neither does an older
 * copy of a document still shipped, which the user saved and the Documents area reports as updated.
 *
 * @param cacheNames The cache names already read from caches.keys(), so an install that has never fetched a
 *   lazy asset is skipped rather than being given an empty cache by caches.open().
 */
async function pruneSupersededVersions(cacheNames: string[]): Promise<void> {
	if (!cacheNames.includes(ASK_ASSET_CACHE)) return;
	// A prune is opportunistic housekeeping: if any cache call rejects, leaving the stale bytes in place
	// until the next activate costs a few megabytes, while letting the error escape waitUntil would fail
	// activation and strand clients on the previous worker.
	try {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const request of await cache.keys()) {
			const url = new URL(request.url);
			// Entries here are written by the same-origin fetch handler below, by the page saving a document
			// (the document and the PDF library) and by the library restore below, all under this origin; the
			// origin check keeps the pathname comparison against the asset list meaningful even so.
			if (url.origin !== sw.location.origin) continue;
			if (isSupersededVersionedEntry(url.pathname, ASSETS)) await cache.delete(request);
		}
	} catch {
		// Intentionally ignored - see above.
	}
}

/**
 * Store this build's PDF library when a saved document needs it and the lazy asset cache lacks it.
 *
 * Saving a document stores the library with it, but a new library release is served from a new folder: the
 * prune above deletes the old pair, and nothing else would store the new one until a reader opens online, so
 * every saved document would open offline only as its text. `libraryToRestore` returns the shipped library
 * files to fetch, and none on a device that saved no document. Run at install, while the release is being
 * downloaded, and again after activation for anything install could not store.
 *
 * @param cacheNames The cache names already read from caches.keys(), so an install that has never fetched a
 *   lazy asset is skipped rather than being given an empty cache by caches.open().
 */
async function restoreLibraryForSavedDocuments(cacheNames: string[]): Promise<void> {
	if (!cacheNames.includes(ASK_ASSET_CACHE)) return;
	// A restore is opportunistic, like the prune: if a fetch or a cache call rejects - or the browser stops the
	// worker part-way, which stores nothing partial - the saved documents open as text offline until the next
	// save or a reader opening online stores the library.
	try {
		const cache = await caches.open(ASK_ASSET_CACHE);
		const cached: string[] = [];
		for (const request of await cache.keys()) {
			const url = new URL(request.url);
			if (url.origin === sw.location.origin) cached.push(url.pathname);
		}
		for (const path of libraryToRestore(cached, ASSETS)) {
			const response = await fetch(path);
			if (response.status === 200) await cache.put(path, response);
		}
	} catch {
		// Intentionally ignored - see above.
	}
}

sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);

	// Only handle same-origin requests
	if (url.origin !== sw.location.origin) return;

	// Never cache the /api/ namespace: it is dynamic + request-specific. Pass it straight to the network
	// so no query-derived response is ever stored. (A retrieve POST is already skipped by the GET guard
	// above; this also excludes any same-origin GET under /api/.)
	if (isApiRequest(url.pathname)) return;

	event.respondWith(
		(async () => {
			// Lazy model/wasm -> their own cache (survives app updates);
			// everything else -> the versioned app-shell cache.
			const cache = await caches.open(
				classifyAsset(url.pathname) === 'lazy' ? ASK_ASSET_CACHE : CACHE
			);

			// Cache-first for built assets
			if (ASSETS.includes(url.pathname)) {
				const cached = await cache.match(event.request);
				if (cached) return cached;
			}

			// Network-first for pages, fall back to cache
			try {
				const response = await fetch(event.request);
				if (response.status === 200 && keptOnFetch(url.pathname)) {
					storeOnFetch(event, cache, event.request, response);
				}
				return response;
			} catch {
				const cached = await cache.match(event.request);
				if (cached) return cached;
				return new Response('Offline', { status: 503 });
			}
		})()
	);
});
