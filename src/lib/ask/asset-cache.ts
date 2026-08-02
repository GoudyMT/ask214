export type CacheStrategy = 'precache' | 'lazy';

/**
 * Decide how the service worker caches a same-origin static asset. The heavy on-device search model +
 * ORT WASM (~45MB total: model + asyncify WASM) are cached LAZILY - fetched + cached on first use (first /ask), never eagerly
 * precached at install - so SW install stays light + robust (a flaky connection can't fail the whole
 * install on the ~45MB) and the model downloads only when the user opts into Ask.
 * Everything else (the app shell + the tiny corpus) is precached so the app works offline immediately.
 *
 * The lazy prefixes mirror the worker's self-host config: `localModelPath = '/models/'` and
 * `wasmPaths = '/wasm/'` (see embed-worker.ts).
 */
export function classifyAsset(pathname: string): CacheStrategy {
	if (pathname.startsWith('/models/') || pathname.startsWith('/wasm/')) return 'lazy';
	return 'precache';
}

/**
 * The lazy model + ORT WASM (~45MB) live in this OWN, UNVERSIONED cache - separate from the versioned
 * app-shell cache (`app-${version}`). The SW's activate cleanup deletes stale app-shell caches on every
 * update; keeping the heavy download here means an app update does NOT evict it (so the "downloaded once,
 * works offline" promise holds). Cleared only by an explicit wipe.
 */
export const ASK_ASSET_CACHE = 'ask-assets';

/**
 * On service-worker activate, decide whether to keep a cache. Keep the current app-shell cache and the
 * unversioned lazy asset cache; delete everything else (stale app-shell caches from prior versions).
 *
 * Args:
 *   key: a cache name from caches.keys()
 *   appCacheName: the current app-shell cache name (`app-${version}`)
 *
 * Returns:
 *   true to keep the cache, false to delete it.
 */
export function shouldKeepCache(key: string, appCacheName: string): boolean {
	return key === appCacheName || key === ASK_ASSET_CACHE;
}

/**
 * The service worker must never cache the `/api/` namespace: the retrieve endpoint is dynamic and
 * request-specific, so a cached response could serve stale or another context's data. A matching request
 * passes straight to the network (the SW does not handle it). The cross-origin browser-direct synthesis
 * call never reaches the SW's same-origin fetch handler at all.
 *
 * @param pathname A same-origin request pathname.
 * @returns true when the request is in the /api/ namespace and must bypass the SW cache.
 */
export function isApiRequest(pathname: string): boolean {
	return pathname.startsWith('/api/');
}
