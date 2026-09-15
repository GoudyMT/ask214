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
 * the old cache on activate and the new bytes are re-fetched on next use. The corpus is versioned the
 * OPPOSITE way - by URL, renaming the artifact - and that does NOT evict anything: the old URL merely stops
 * being requested while its entry stays cached at full size. Superseded corpus entries are therefore pruned
 * one at a time on activate (see `isSupersededCorpusEntry`). Also cleared by an explicit wipe.
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
 * Decide whether one cached ENTRY inside ASK_ASSET_CACHE is a corpus artifact this build no longer ships.
 *
 * `shouldKeepCache` works at whole-cache granularity and keeps ASK_ASSET_CACHE unconditionally, so nothing
 * else ever retires anything inside it. That is right for the model + ORT WASM, which are served from stable
 * URLs and so are overwritten in place, but wrong for the corpus: the corpus is versioned BY URL, so a
 * content change renames `corpus-vX.*` to `corpus-vY.*` and the cache gains the new ~7MB while keeping the
 * old pair forever. Left alone, every rebuild adds a dead generation next to the ~45MB model, and a browser
 * that evicts the whole origin under storage pressure (Safari/iOS) takes the model down with it.
 *
 * Two conditions must BOTH hold before an entry is marked, which is what bounds over-eviction:
 *   - the entry is inside the `/corpus/` namespace (the same namespace `classifyAsset` routes into this
 *     cache), so a `/models/` or `/wasm/` entry can never match no matter what the asset list contains;
 *   - this build actually ships a corpus, so an unexpected asset list (corpus served from somewhere other
 *     than the static directory, or an empty list) prunes nothing instead of wiping the live copy. A stale
 *     entry costs bytes; a wrongly deleted one costs an offline user their answers.
 *
 * Args:
 *   pathname: the pathname of a cached entry's request URL
 *   currentAssets: the pathnames this build ships (the service worker's build + files list), which carries
 *     the current corpus identity - so no corpus filename is hardcoded here and a version bump needs no edit
 *
 * Returns:
 *   true when the entry is a superseded corpus artifact and can be deleted.
 */
export function isSupersededCorpusEntry(
	pathname: string,
	currentAssets: readonly string[]
): boolean {
	if (!pathname.startsWith('/corpus/')) return false;
	if (!currentAssets.some((asset) => asset.startsWith('/corpus/'))) return false;
	return !currentAssets.includes(pathname);
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
