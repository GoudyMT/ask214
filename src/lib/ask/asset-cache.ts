export type CacheStrategy = 'precache' | 'lazy';

/**
 * Decide how the service worker caches a same-origin static asset. The heavy on-device search model +
 * ORT WASM (~34MB total) are cached LAZILY - fetched + cached on first use (first /ask), never eagerly
 * precached at install - so SW install stays light + robust (a flaky connection can't fail the whole
 * install on the 34MB) and the model downloads only when the user opts into Ask (ADR-015 / spec section 9).
 * Everything else (the app shell + the tiny corpus) is precached so the app works offline immediately.
 *
 * The lazy prefixes mirror the worker's self-host config: `localModelPath = '/models/'` and
 * `wasmPaths = '/wasm/'` (see embed-worker.ts).
 */
export function classifyAsset(pathname: string): CacheStrategy {
	if (pathname.startsWith('/models/') || pathname.startsWith('/wasm/')) return 'lazy';
	return 'precache';
}
