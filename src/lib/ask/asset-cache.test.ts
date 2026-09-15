import { describe, it, expect } from 'vitest';
import {
	classifyAsset,
	ASK_ASSET_CACHE,
	shouldKeepCache,
	isSupersededCorpusEntry,
	isApiRequest
} from './asset-cache';

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
		expect(classifyAsset('/corpus/corpus-v1.0.2.json')).toBe('lazy');
		expect(classifyAsset('/corpus/corpus-v1.0.2.embeddings.bin')).toBe('lazy');
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

// shouldKeepCache decides whole CACHES by name, and the lazy asset cache's name is app-version-independent,
// so nothing in that sweep ever touches its ENTRIES. That is correct for the model + ORT WASM, whose URLs
// are stable (the ~45MB the cache exists to protect), but the corpus is versioned by URL: every rebuild
// ships a new filename, so the old generation's ~7MB would sit in the cache forever. isSupersededCorpusEntry
// marks those orphans one entry at a time, reading the CURRENT corpus identity off the shipped asset list
// so no filename is hardcoded and a version bump needs no edit here.
describe('isSupersededCorpusEntry (per-entry pruning inside the lazy asset cache)', () => {
	// The asset list as the service worker sees it: the SvelteKit build output plus everything in static/,
	// which is where the corpus, the model, and the ORT WASM all ship from.
	const SHIPPED = [
		'/_app/immutable/entry/start.js',
		'/corpus/corpus-v1.0.2.json',
		'/corpus/corpus-v1.0.2.embeddings.bin',
		'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
		'/wasm/ort-wasm-simd-threaded.wasm'
	];

	it('marks a corpus generation that is no longer shipped', () => {
		expect(isSupersededCorpusEntry('/corpus/corpus-v1.0.json', SHIPPED)).toBe(true);
		expect(isSupersededCorpusEntry('/corpus/corpus-v1.0.embeddings.bin', SHIPPED)).toBe(true);
		expect(isSupersededCorpusEntry('/corpus/corpus-v1.0.1.json', SHIPPED)).toBe(true);
		expect(isSupersededCorpusEntry('/corpus/corpus-v1.0.1.embeddings.bin', SHIPPED)).toBe(true);
	});

	it('keeps the CURRENT corpus, and follows the asset list when its version bumps', () => {
		expect(isSupersededCorpusEntry('/corpus/corpus-v1.0.2.json', SHIPPED)).toBe(false);
		expect(isSupersededCorpusEntry('/corpus/corpus-v1.0.2.embeddings.bin', SHIPPED)).toBe(false);
		// Current identity is an input, not a literal: rename the artifact and the same entry that was
		// current a deploy ago becomes the superseded one, with no change to this module.
		const bumped = ['/corpus/corpus-v9.9.json', '/corpus/corpus-v9.9.embeddings.bin'];
		expect(isSupersededCorpusEntry('/corpus/corpus-v9.9.json', bumped)).toBe(false);
		expect(isSupersededCorpusEntry('/corpus/corpus-v1.0.2.json', bumped)).toBe(true);
	});

	it('NEVER marks the model or ORT WASM, even for a path absent from the asset list', () => {
		// The heavy download is precisely what this cache protects, and its paths change under the same
		// conditions the corpus ones do (a re-vendor renames files). A predicate that asked only "is this
		// missing from the asset list?" would evict 45MB here; the /corpus/ gate is what prevents it.
		const corpusOnly = ['/corpus/corpus-v1.0.2.json', '/corpus/corpus-v1.0.2.embeddings.bin'];
		expect(
			isSupersededCorpusEntry(
				'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
				corpusOnly
			)
		).toBe(false);
		expect(
			isSupersededCorpusEntry('/models/Xenova/all-MiniLM-L6-v2/tokenizer.json', corpusOnly)
		).toBe(false);
		expect(isSupersededCorpusEntry('/wasm/ort-wasm-simd-threaded.asyncify.wasm', corpusOnly)).toBe(
			false
		);
		// A path that only resembles the corpus namespace is outside it.
		expect(isSupersededCorpusEntry('/corpusfoo.json', SHIPPED)).toBe(false);
		expect(isSupersededCorpusEntry('/ask', SHIPPED)).toBe(false);
	});

	it('splits a realistic cache listing into exactly the orphans and exactly the survivors', () => {
		// Whole-listing form, so an inverted or over-broad predicate fails on the SETS, not just a count.
		const cached = [
			'/corpus/corpus-v1.0.json',
			'/corpus/corpus-v1.0.embeddings.bin',
			'/corpus/corpus-v1.0.1.json',
			'/corpus/corpus-v1.0.1.embeddings.bin',
			'/corpus/corpus-v1.0.2.json',
			'/corpus/corpus-v1.0.2.embeddings.bin',
			'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
			'/wasm/ort-wasm-simd-threaded.wasm'
		];
		expect(cached.filter((path) => isSupersededCorpusEntry(path, SHIPPED))).toEqual([
			'/corpus/corpus-v1.0.json',
			'/corpus/corpus-v1.0.embeddings.bin',
			'/corpus/corpus-v1.0.1.json',
			'/corpus/corpus-v1.0.1.embeddings.bin'
		]);
		expect(cached.filter((path) => !isSupersededCorpusEntry(path, SHIPPED))).toEqual([
			'/corpus/corpus-v1.0.2.json',
			'/corpus/corpus-v1.0.2.embeddings.bin',
			'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
			'/wasm/ort-wasm-simd-threaded.wasm'
		]);
	});

	it('marks nothing when the asset list carries no corpus at all (fails closed)', () => {
		// If the corpus ever stops shipping from static/ - or the list arrives empty - then "absent from the
		// asset list" describes the LIVE corpus too, and a keen predicate would wipe the offline user's only
		// copy. Evicting nothing is the safe read of an unknown list: a stale entry costs bytes, a wrongly
		// evicted one costs answers.
		expect(
			isSupersededCorpusEntry('/corpus/corpus-v1.0.2.json', ['/_app/immutable/entry/start.js'])
		).toBe(false);
		expect(isSupersededCorpusEntry('/corpus/corpus-v1.0.json', [])).toBe(false);
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
		expect(isApiRequest('/corpus/corpus-v1.0.2.json')).toBe(false);
		expect(isApiRequest('/apidocs')).toBe(false); // not the /api/ namespace
	});
});
