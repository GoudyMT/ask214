import { describe, it, expect } from 'vitest';
import { classifyAsset, ASK_ASSET_CACHE, shouldKeepCache } from './asset-cache';

// classifyAsset decides how the service worker caches a same-origin static asset. The heavy on-device
// model + ORT WASM (~45MB) are LAZY (cached on first use, never eagerly precached at install); the app
// shell + the tiny corpus are PRECACHE (eager, so the app works offline immediately). See ADR-015 / spec 9.
describe('classifyAsset', () => {
	it('marks the heavy model + ORT WASM as lazy (kept out of the install precache)', () => {
		expect(classifyAsset('/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx')).toBe('lazy');
		expect(classifyAsset('/models/Xenova/all-MiniLM-L6-v2/config.json')).toBe('lazy');
		expect(classifyAsset('/wasm/ort-wasm-simd-threaded.wasm')).toBe('lazy');
	});

	it('marks the app shell + tiny corpus + icons as precache', () => {
		expect(classifyAsset('/_app/immutable/entry/start.js')).toBe('precache');
		expect(classifyAsset('/corpus/corpus-v1.0.json')).toBe('precache');
		expect(classifyAsset('/corpus/corpus-v1.0.embeddings.bin')).toBe('precache');
		expect(classifyAsset('/favicon.png')).toBe('precache');
	});
});

// The lazy model/wasm live in their OWN unversioned cache so an app update (which deletes stale
// app-${version} caches) does NOT evict the ~45MB download (sweep S26 H2 - "downloaded once").
describe('shouldKeepCache (cache partitioning across app updates)', () => {
	it('keeps the current app-shell cache and the unversioned lazy asset cache', () => {
		expect(shouldKeepCache('app-v2', 'app-v2')).toBe(true);
		expect(shouldKeepCache(ASK_ASSET_CACHE, 'app-v2')).toBe(true);
	});

	it('deletes a stale app-shell cache from a prior version', () => {
		expect(shouldKeepCache('app-v1', 'app-v2')).toBe(false);
	});

	it('keeps the lazy asset cache across ANY app version (it is unversioned)', () => {
		expect(shouldKeepCache(ASK_ASSET_CACHE, 'app-v1')).toBe(true);
		expect(shouldKeepCache(ASK_ASSET_CACHE, 'app-v99')).toBe(true);
		expect(ASK_ASSET_CACHE.startsWith('app-')).toBe(false);
	});
});
