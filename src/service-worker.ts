/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';
import {
	classifyAsset,
	ASK_ASSET_CACHE,
	shouldKeepCache,
	isSupersededCorpusEntry,
	isApiRequest
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
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			for (const key of keys) {
				// Keep the current app-shell cache + the lazy asset cache; drop stale app caches.
				if (!shouldKeepCache(key, CACHE)) await caches.delete(key);
			}
			await pruneSupersededCorpus(keys);
			await sw.clients.claim();
		})()
	);
});

/**
 * Delete corpus artifacts this build no longer ships from the lazy asset cache.
 *
 * The sweep above keeps ASK_ASSET_CACHE by name on every deploy, which is what protects the ~45MB model +
 * ORT WASM download. The corpus lives in that same cache but is versioned by URL, so a rebuild adds the new
 * filename and orphans the old one: without a per-entry prune each deploy leaves another ~7MB of bytes that
 * nothing will ever request again. `isSupersededCorpusEntry` is given this build's asset list, so only
 * `/corpus/` entries missing from it are removed - the model, the WASM, and the current corpus never match.
 *
 * @param cacheNames The cache names already read from caches.keys(), so an install that has never fetched a
 *   lazy asset is skipped rather than being given an empty cache by caches.open().
 */
async function pruneSupersededCorpus(cacheNames: string[]): Promise<void> {
	if (!cacheNames.includes(ASK_ASSET_CACHE)) return;
	// A prune is opportunistic housekeeping: if any cache call rejects, leaving the stale bytes in place
	// until the next activate costs a few megabytes, while letting the error escape waitUntil would fail
	// activation and strand clients on the previous worker.
	try {
		const cache = await caches.open(ASK_ASSET_CACHE);
		for (const request of await cache.keys()) {
			const url = new URL(request.url);
			// Entries here are written only by the same-origin fetch handler below; the origin check keeps
			// the pathname comparison against the asset list meaningful even so.
			if (url.origin !== sw.location.origin) continue;
			if (isSupersededCorpusEntry(url.pathname, ASSETS)) await cache.delete(request);
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
				if (response.status === 200) {
					cache.put(event.request, response.clone());
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
