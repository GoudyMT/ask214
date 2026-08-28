import { describe, it, expect } from 'vitest';
import { classifyAsset, ASK_ASSET_CACHE, shouldKeepCache, isApiRequest } from './asset-cache';

// classifyAsset decides how the service worker caches a same-origin static asset. The heavy on-device
// model + ORT WASM (~45MB) and the ~3.5MB corpus are LAZY (cached on first use, never eagerly precached at
// install); the app shell + icons are PRECACHE (eager, so the shell works offline immediately).
describe('classifyAsset', () => {
	it('marks the heavy model, ORT WASM, and the corpus as lazy (kept out of the install precache)', () => {
		expect(classifyAsset('/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx')).toBe('lazy');
		expect(classifyAsset('/models/Xenova/all-MiniLM-L6-v2/config.json')).toBe('lazy');
		expect(classifyAsset('/wasm/ort-wasm-simd-threaded.wasm')).toBe('lazy');
		// The ~3.5MB corpus is lazy too: fetched on demand (a device query or a "Read more" click) and cached
		// then, so it never crosses the wire on a passive page load (including the SW install).
		expect(classifyAsset('/corpus/corpus-v1.0.1.json')).toBe('lazy');
		expect(classifyAsset('/corpus/corpus-v1.0.1.embeddings.bin')).toBe('lazy');
	});

	it('marks the app shell + icons as precache', () => {
		expect(classifyAsset('/_app/immutable/entry/start.js')).toBe('precache');
		expect(classifyAsset('/favicon.png')).toBe('precache');
	});
});

// The lazy model/wasm live in their OWN cache, whose name is independent of the app version, so an app
// update (which deletes stale app-${version} caches) does NOT evict the ~45MB download. The -vN suffix
// is the cache-bust seam: bump it to re-vendor the model/wasm (their URLs are stable), evicting the old.
describe('shouldKeepCache (cache partitioning across app updates)', () => {
	it('keeps the current app-shell cache and the unversioned lazy asset cache', () => {
		expect(shouldKeepCache('app-v2', 'app-v2')).toBe(true);
		expect(shouldKeepCache(ASK_ASSET_CACHE, 'app-v2')).toBe(true);
	});

	it('deletes a stale app-shell cache from a prior version', () => {
		expect(shouldKeepCache('app-v1', 'app-v2')).toBe(false);
	});

	it('keeps the lazy asset cache across ANY app version (its name is app-version-independent)', () => {
		expect(shouldKeepCache(ASK_ASSET_CACHE, 'app-v1')).toBe(true);
		expect(shouldKeepCache(ASK_ASSET_CACHE, 'app-v99')).toBe(true);
		expect(ASK_ASSET_CACHE.startsWith('app-')).toBe(false);
	});

	it('evicts an OLD lazy-cache version once the suffix is bumped (the model/wasm cache-bust)', () => {
		// A re-vendor of the model/wasm bumps ASK_ASSET_CACHE's -vN suffix; the prior version is no longer
		// the current name, so activate deletes it and the new bytes are re-fetched on next use.
		expect(shouldKeepCache('ask-assets-v0', 'app-v2')).toBe(false);
		expect(ASK_ASSET_CACHE).toMatch(/-v\d+$/);
	});
});

// The service worker must never cache the /api/ namespace: the retrieve endpoint is dynamic + request-
// specific, so a cached response could serve stale or another context's data. These pass straight to the
// network.
describe('isApiRequest (the SW never caches the API namespace)', () => {
	it('is true for any /api/ path', () => {
		expect(isApiRequest('/api/retrieve')).toBe(true);
		expect(isApiRequest('/api/anything/else')).toBe(true);
	});

	it('is false for app pages and static assets', () => {
		expect(isApiRequest('/')).toBe(false);
		expect(isApiRequest('/ask')).toBe(false);
		expect(isApiRequest('/corpus/corpus-v1.0.1.json')).toBe(false);
		expect(isApiRequest('/apidocs')).toBe(false); // not the /api/ namespace
	});
});
