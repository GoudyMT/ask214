export type CacheStrategy = 'precache' | 'lazy';

/**
 * Decide how the service worker caches a same-origin static asset. The heavy on-device search model +
 * ORT WASM (~45MB total: model + asyncify WASM) AND the ~3.5MB corpus are cached LAZILY - fetched + cached
 * on first use (a device query or a "Read more" click), never eagerly precached at install. That keeps SW
 * install light + robust (a flaky connection can't fail the whole install on a multi-megabyte asset), keeps
 * the corpus off every passive page load (so it never blocks LCP/TTI), and spares online-only users the
 * corpus download. Everything else (the app shell + icons) is precached so the shell works offline at once.
 *
 * The lazy prefixes mirror the worker's self-host config: `localModelPath = '/models/'` and
 * `wasmPaths = '/wasm/'` (see embed-worker.ts); `/corpus/` is the versioned corpus artifact.
 */
export function classifyAsset(pathname: string): CacheStrategy {
	if (
		pathname.startsWith('/models/') ||
		pathname.startsWith('/wasm/') ||
		pathname.startsWith('/corpus/')
	)
		return 'lazy';
	return 'precache';
}

/**
 * The lazy model + ORT WASM (~45MB) live in this OWN cache, whose name is INDEPENDENT of the app version -
 * so an app deploy (which deletes stale `app-${version}` caches) does NOT evict the heavy download (the
 * "downloaded once, works offline" promise holds). The `-vN` suffix is the ONLY cache-bust seam for the
 * vendored model + wasm, whose URLs are stable and served cache-first forever: when those bytes are
 * re-vendored (e.g. an onnxruntime-web security patch), BUMP this suffix - `shouldKeepCache` then evicts
 * the old cache on activate and the new bytes are re-fetched on next use. (Mirrors the corpus filename
 * bump, which versions the corpus by URL instead.) Also cleared by an explicit wipe.
 */
export const ASK_ASSET_CACHE = 'ask-assets-v1';

/**
 * On service-worker activate, decide whether to keep a cache. Keep the current app-shell cache and the
 * lazy asset cache; delete everything else (stale app-shell caches from prior versions).
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
