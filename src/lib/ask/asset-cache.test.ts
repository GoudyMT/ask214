import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import {
	classifyAsset,
	ASK_ASSET_CACHE,
	shouldKeepCache,
	isSupersededVersionedEntry,
	isApiRequest,
	keptOnFetch,
	libraryToRestore,
	answerLibraryToRestore,
	restoreLibraries,
	workerScriptsNamed,
	keepWorkerScripts,
	storeOnFetch,
	carryOverSavedDocuments,
	keptOnActivate,
	APP_SHELL,
	offlineResponse
} from './asset-cache';

// classifyAsset decides how the service worker caches a same-origin static asset. The heavy on-device
// model + ORT WASM (~45MB) and the ~3.5MB corpus are LAZY (cached on first use, never eagerly precached at
// install); the app shell + icons are PRECACHE (eager, so the shell works offline immediately).
describe('classifyAsset', () => {
	it('marks the heavy model, ORT WASM, and the corpus as lazy (kept out of the install precache)', () => {
		expect(classifyAsset('/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx')).toBe('lazy');
		expect(classifyAsset('/models/Xenova/all-MiniLM-L6-v2/config.json')).toBe('lazy');
		expect(classifyAsset('/wasm/ort-wasm-simd-threaded.asyncify.wasm')).toBe('lazy');
		// The ~3.5MB corpus is lazy too: fetched on demand (a device query or a "Read more" click) and cached
		// then, so it never crosses the wire on a passive page load (including the SW install).
		expect(classifyAsset('/corpus/corpus-v1.0.2.json')).toBe('lazy');
		expect(classifyAsset('/corpus/corpus-v1.0.2.embeddings.bin')).toBe('lazy');
	});

	it('marks the served source documents as lazy', () => {
		expect(classifyAsset('/docs/tap_va_home_loan.1390c011.pdf')).toBe('lazy');
	});

	it('marks the pdf worker as lazy', () => {
		expect(classifyAsset('/pdf-worker/pdf.worker.min.mjs')).toBe('lazy');
	});

	it('marks the app shell + icons as precache', () => {
		expect(classifyAsset('/_app/immutable/entry/start.js')).toBe('precache');
		expect(classifyAsset('/favicon.png')).toBe('precache');
	});

	// The install writes its precache entries as one batch, so every megabyte admitted here is both a
	// download for someone who may never need it AND another chance for the whole install to fail on a
	// flaky connection. Measured before this guard existed: the documents and the worker together put
	// about 82 MB into that batch.
	it('admits no heavy namespace into the install precache', () => {
		const assets = [
			'/index.html',
			'/docs/tap_va_benefits_guide.e19cf939.pdf',
			'/pdf-worker/pdf.worker.min.mjs',
			'/corpus/corpus-v1.0.2.json',
			'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
			'/wasm/ort-wasm-simd-threaded.asyncify.wasm'
		];
		expect(assets.filter((path) => classifyAsset(path) === 'precache')).toEqual(['/index.html']);
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
// ships a new filename, so the old generation's ~7MB would sit in the cache forever. isSupersededVersionedEntry
// marks those orphans one entry at a time, reading the CURRENT corpus identity off the shipped asset list
// so no filename is hardcoded and a version bump needs no edit here.
describe('isSupersededVersionedEntry (per-entry pruning inside the lazy asset cache)', () => {
	// The asset list as the service worker sees it: the SvelteKit build output plus everything in static/,
	// which is where the corpus, the model, and the ORT WASM all ship from.
	const SHIPPED = [
		'/_app/immutable/entry/start.js',
		'/corpus/corpus-v1.0.2.json',
		'/corpus/corpus-v1.0.2.embeddings.bin',
		'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
		'/wasm/ort-wasm-simd-threaded.asyncify.wasm'
	];

	it('marks a corpus generation that is no longer shipped', () => {
		expect(isSupersededVersionedEntry('/corpus/corpus-v1.0.json', SHIPPED)).toBe(true);
		expect(isSupersededVersionedEntry('/corpus/corpus-v1.0.embeddings.bin', SHIPPED)).toBe(true);
		expect(isSupersededVersionedEntry('/corpus/corpus-v1.0.1.json', SHIPPED)).toBe(true);
		expect(isSupersededVersionedEntry('/corpus/corpus-v1.0.1.embeddings.bin', SHIPPED)).toBe(true);
	});

	it('keeps the CURRENT corpus, and follows the asset list when its version bumps', () => {
		expect(isSupersededVersionedEntry('/corpus/corpus-v1.0.2.json', SHIPPED)).toBe(false);
		expect(isSupersededVersionedEntry('/corpus/corpus-v1.0.2.embeddings.bin', SHIPPED)).toBe(false);
		// Current identity is an input, not a literal: rename the artifact and the same entry that was
		// current a deploy ago becomes the superseded one, with no change to this module.
		const bumped = ['/corpus/corpus-v9.9.json', '/corpus/corpus-v9.9.embeddings.bin'];
		expect(isSupersededVersionedEntry('/corpus/corpus-v9.9.json', bumped)).toBe(false);
		expect(isSupersededVersionedEntry('/corpus/corpus-v1.0.2.json', bumped)).toBe(true);
	});

	it('NEVER marks the model or ORT WASM, even for a path absent from the asset list', () => {
		// The heavy download is precisely what this cache protects, and its paths change under the same
		// conditions the corpus ones do (a re-vendor renames files). A predicate that asked only "is this
		// missing from the asset list?" would evict 45MB here; the /corpus/ gate is what prevents it.
		const corpusOnly = ['/corpus/corpus-v1.0.2.json', '/corpus/corpus-v1.0.2.embeddings.bin'];
		expect(
			isSupersededVersionedEntry(
				'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
				corpusOnly
			)
		).toBe(false);
		expect(
			isSupersededVersionedEntry('/models/Xenova/all-MiniLM-L6-v2/tokenizer.json', corpusOnly)
		).toBe(false);
		expect(
			isSupersededVersionedEntry('/wasm/ort-wasm-simd-threaded.asyncify.wasm', corpusOnly)
		).toBe(false);
		// A path that only resembles the corpus namespace is outside it.
		expect(isSupersededVersionedEntry('/corpusfoo.json', SHIPPED)).toBe(false);
		expect(isSupersededVersionedEntry('/ask', SHIPPED)).toBe(false);
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
			'/wasm/ort-wasm-simd-threaded.asyncify.wasm'
		];
		expect(cached.filter((path) => isSupersededVersionedEntry(path, SHIPPED))).toEqual([
			'/corpus/corpus-v1.0.json',
			'/corpus/corpus-v1.0.embeddings.bin',
			'/corpus/corpus-v1.0.1.json',
			'/corpus/corpus-v1.0.1.embeddings.bin'
		]);
		expect(cached.filter((path) => !isSupersededVersionedEntry(path, SHIPPED))).toEqual([
			'/corpus/corpus-v1.0.2.json',
			'/corpus/corpus-v1.0.2.embeddings.bin',
			'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
			'/wasm/ort-wasm-simd-threaded.asyncify.wasm'
		]);
	});

	it('marks nothing when the asset list carries no corpus at all (fails closed)', () => {
		// If the corpus ever stops shipping from static/ - or the list arrives empty - then "absent from the
		// asset list" describes the LIVE corpus too, and a keen predicate would wipe the offline user's only
		// copy. Evicting nothing is the safe read of an unknown list: a stale entry costs bytes, a wrongly
		// evicted one costs answers.
		expect(
			isSupersededVersionedEntry('/corpus/corpus-v1.0.2.json', ['/_app/immutable/entry/start.js'])
		).toBe(false);
		expect(isSupersededVersionedEntry('/corpus/corpus-v1.0.json', [])).toBe(false);
	});
});

// The served documents and the pdf library are versioned by URL too, but they differ from the corpus in one
// way that decides the rule. A saved document is the user's choice and is kept until they remove it, so an
// old copy of a document this build still ships is NOT pruned - it is the record that tells the Documents
// area the document was updated. Only a document whose SOURCE is gone, and a pdf library release no longer
// shipped, are dead weight.
describe('isSupersededVersionedEntry - documents and the pdf library', () => {
	it('keeps an old version of a document this build still ships - the Documents area reads it', () => {
		const assets = ['/docs/tap_vet_centers.2222bbbb.pdf', '/corpus/corpus-v1.0.2.json'];
		expect(isSupersededVersionedEntry('/docs/tap_vet_centers.1dcfd966.pdf', assets)).toBe(false);
		expect(isSupersededVersionedEntry('/docs/tap_vet_centers.2222bbbb.pdf', assets)).toBe(false);
	});

	it('prunes a document whose source this build no longer ships', () => {
		const assets = ['/docs/tap_vet_centers.2222bbbb.pdf', '/corpus/corpus-v1.0.2.json'];
		expect(isSupersededVersionedEntry('/docs/tap_retired_guide.1111aaaa.pdf', assets)).toBe(true);
	});

	it('matches a source id whole, so a shipped id that merely starts with it keeps nothing alive', () => {
		const assets = ['/docs/tap_va_education_spouses.183d4b7e.pdf'];
		expect(isSupersededVersionedEntry('/docs/tap_va_education.1111aaaa.pdf', assets)).toBe(true);
	});

	it('prunes a pdf library pair from a release this build no longer ships', () => {
		const assets = ['/pdf-worker/6.4.0/pdf.min.mjs', '/pdf-worker/6.4.0/pdf.worker.min.mjs'];
		expect(isSupersededVersionedEntry('/pdf-worker/6.3.289/pdf.min.mjs', assets)).toBe(true);
		expect(isSupersededVersionedEntry('/pdf-worker/6.3.289/pdf.worker.min.mjs', assets)).toBe(true);
		expect(isSupersededVersionedEntry('/pdf-worker/6.4.0/pdf.min.mjs', assets)).toBe(false);
	});

	it('checks each namespace on its own, so a build that ships no documents keeps every saved one', () => {
		// A list with no /docs/ entry is unexpected (documents served from elsewhere, or a broken list). It
		// must prune nothing in that namespace rather than wipe every document the user saved.
		const assets = ['/corpus/corpus-v1.0.2.json', '/pdf-worker/6.3.289/pdf.min.mjs'];
		expect(isSupersededVersionedEntry('/docs/tap_retired_guide.1111aaaa.pdf', assets)).toBe(false);
	});

	it('never marks the model or the wasm, whatever the asset list', () => {
		// The list ships OTHER model and wasm files, as the real one does, while the probed paths are absent
		// from it - where a re-vendor leaves the old ones. Only the namespace gate keeps them; without those
		// entries the per-namespace "ships nothing here" guard would keep them anyway and hide its absence.
		const assets = [
			'/docs/tap_vet_centers.2222bbbb.pdf',
			'/corpus/corpus-v1.0.2.json',
			'/models/Xenova/all-MiniLM-L6-v2/config.json',
			'/wasm/ort-wasm-simd-threaded.asyncify.mjs'
		];
		expect(
			isSupersededVersionedEntry(
				'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
				assets
			)
		).toBe(false);
		expect(isSupersededVersionedEntry('/wasm/ort-wasm-simd-threaded.asyncify.wasm', assets)).toBe(
			false
		);
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

// A source document is kept only when the user saves it; the worker passes a viewed one through untouched.
describe('keptOnFetch (what the worker keeps from a response it passes through)', () => {
	it('keeps no source document', () => {
		expect(keptOnFetch('/docs/tap_dol_efct.71de2688.pdf')).toBe(false);
		expect(keptOnFetch('/docs/tap_dol_employment_workshop.99c9fb99.pdf')).toBe(false);
	});

	it('keeps the model, the wasm, the corpus, the pdf library and the app shell', () => {
		expect(keptOnFetch('/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx')).toBe(true);
		expect(keptOnFetch('/wasm/ort-wasm-simd-threaded.asyncify.wasm')).toBe(true);
		expect(keptOnFetch('/corpus/corpus-v1.0.2.json')).toBe(true);
		expect(keptOnFetch('/pdf-worker/6.3.289/pdf.min.mjs')).toBe(true);
		expect(keptOnFetch('/')).toBe(true);
		expect(keptOnFetch('/documents')).toBe(true); // the Documents page, not the /docs/ namespace
	});
});

// A saved document draws its page offline only with the PDF library. An update that moves the library to a new
// release folder prunes the old pair on activate, and nothing else would store the new one until a reader
// opens online - so activate restores it, but only on a device that holds a saved document.
/** Several named caches, each a map of pathname to body, behind the Cache API calls the carry-over makes. */
function namedCaches(
	initial: Record<string, Record<string, string>>,
	options: { putThrows?: boolean } = {}
) {
	const store = new Map(
		Object.entries(initial).map(([name, entries]) => [name, new Map(Object.entries(entries))])
	);
	const pathOf = (request: Request | string) =>
		new URL(typeof request === 'string' ? request : request.url, 'https://ask214.com').pathname;
	const cacheOf = (name: string) => {
		const entries = store.get(name) ?? new Map<string, string>();
		store.set(name, entries);
		return {
			async keys() {
				return [...entries.keys()].map((path) => new Request(`https://ask214.com${path}`));
			},
			async match(request: Request | string) {
				const body = entries.get(pathOf(request));
				return body === undefined ? undefined : new Response(body);
			},
			async put(request: Request | string, response: Response) {
				if (options.putThrows) throw new DOMException('full', 'QuotaExceededError');
				entries.set(pathOf(request), await response.text());
			}
		};
	};
	const api = {
		async keys() {
			return [...store.keys()];
		},
		async open(name: string) {
			return cacheOf(name);
		}
	} as unknown as CacheStorage;
	return { api, held: (name: string) => Object.fromEntries(store.get(name) ?? []) };
}

// The model's cache-bust gives the asset cache a new name, and activate deletes the old one whole. The user's
// saved documents - and the page reader and answer library that draw and read them - live there too, and a
// saved document is kept until the user removes it.
describe('carryOverSavedDocuments (a new asset-cache name keeps what the user saved)', () => {
	const EARLIER = 'ask-assets-v0';
	const MODEL = '/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx';

	it('carries saved documents, the page reader and the answer library, not the model or the WASM', async () => {
		const { api, held } = namedCaches({
			[EARLIER]: {
				'/docs/tap_vet_centers.1dcfd966.pdf': 'doc',
				'/pdf-worker/6.3.289/pdf.min.mjs': 'lib',
				'/corpus/corpus-v1.0.2.json': 'text',
				[MODEL]: 'model',
				'/wasm/ort-wasm-simd-threaded.asyncify.wasm': 'wasm'
			}
		});
		expect(await carryOverSavedDocuments(api)).toEqual(new Set([EARLIER]));
		expect(held(ASK_ASSET_CACHE)).toEqual({
			'/docs/tap_vet_centers.1dcfd966.pdf': 'doc',
			'/pdf-worker/6.3.289/pdf.min.mjs': 'lib',
			'/corpus/corpus-v1.0.2.json': 'text'
		});
	});

	it('keeps what the current cache already holds', async () => {
		const { api, held } = namedCaches({
			[EARLIER]: { '/docs/tap_vet_centers.1dcfd966.pdf': 'old' },
			[ASK_ASSET_CACHE]: { '/docs/tap_vet_centers.1dcfd966.pdf': 'new' }
		});
		await carryOverSavedDocuments(api);
		expect(held(ASK_ASSET_CACHE)).toEqual({ '/docs/tap_vet_centers.1dcfd966.pdf': 'new' });
	});

	it('does not count a cache it could not carry, so activate keeps it for the next try', async () => {
		const { api } = namedCaches(
			{ [EARLIER]: { '/docs/tap_vet_centers.1dcfd966.pdf': 'doc' } },
			{ putThrows: true }
		);
		expect(await carryOverSavedDocuments(api)).toEqual(new Set());
	});

	it('ignores caches that are not an earlier asset cache', async () => {
		const { api, held } = namedCaches({
			'app-1790000000000': { '/docs/tap_vet_centers.1dcfd966.pdf': 'shell' },
			'transformers-cache': { '/docs/tap_va101.0f650528.pdf': 'other' }
		});
		expect(await carryOverSavedDocuments(api)).toEqual(new Set());
		expect(held(ASK_ASSET_CACHE)).toEqual({});
	});
});

describe('keptOnActivate', () => {
	it('keeps the current caches, and an earlier asset cache only until it has been carried over', () => {
		expect(keptOnActivate('app-2', 'app-2', new Set())).toBe(true);
		expect(keptOnActivate(ASK_ASSET_CACHE, 'app-2', new Set())).toBe(true);
		expect(keptOnActivate('app-1', 'app-2', new Set())).toBe(false);
		expect(keptOnActivate('ask-assets-v0', 'app-2', new Set())).toBe(true);
		expect(keptOnActivate('ask-assets-v0', 'app-2', new Set(['ask-assets-v0']))).toBe(false);
	});
});

describe('libraryToRestore (the PDF library a saved document needs after an update)', () => {
	const SHIPPED = [
		'/_app/immutable/entry/start.js',
		'/corpus/corpus-v1.0.2.json',
		'/docs/tap_vet_centers.1dcfd966.pdf',
		'/docs/tap_va101.0f650528.pdf',
		'/pdf-worker/6.4.0/pdf.min.mjs',
		'/pdf-worker/6.4.0/pdf.worker.min.mjs'
	];
	const MODEL = '/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx';

	it('returns the shipped library when a document is saved and the library is not held', () => {
		expect(libraryToRestore(['/docs/tap_vet_centers.1dcfd966.pdf', MODEL], SHIPPED)).toEqual([
			'/pdf-worker/6.4.0/pdf.min.mjs',
			'/pdf-worker/6.4.0/pdf.worker.min.mjs'
		]);
	});

	it('returns nothing when the saved documents already have the shipped library', () => {
		const cached = [
			'/docs/tap_vet_centers.1dcfd966.pdf',
			'/pdf-worker/6.4.0/pdf.min.mjs',
			'/pdf-worker/6.4.0/pdf.worker.min.mjs'
		];
		expect(libraryToRestore(cached, SHIPPED)).toEqual([]);
		// Half a pair held, as an interrupted restore leaves it: only the missing half is returned.
		expect(libraryToRestore(cached.slice(0, 2), SHIPPED)).toEqual([
			'/pdf-worker/6.4.0/pdf.worker.min.mjs'
		]);
	});

	// A device that saved nothing never asked for the library to be kept, so an update downloads nothing for it.
	it('returns nothing on a device with no saved document, even with the library missing', () => {
		expect(libraryToRestore([MODEL, '/corpus/corpus-v1.0.2.json'], SHIPPED)).toEqual([]);
		expect(libraryToRestore([], SHIPPED)).toEqual([]);
	});

	// The shipped list carries every document, the corpus and the app shell, none of them cached here. Only the
	// library is restored: a saved document's own update is the user's to take from the Documents area.
	it('returns only library files, never another shipped file the cache lacks', () => {
		const cached = [
			'/docs/tap_vet_centers.0badc0de.pdf',
			'/pdf-worker/6.3.289/pdf.min.mjs',
			'/pdf-worker/6.3.289/pdf.worker.min.mjs'
		];
		expect(libraryToRestore(cached, SHIPPED)).toEqual([
			'/pdf-worker/6.4.0/pdf.min.mjs',
			'/pdf-worker/6.4.0/pdf.worker.min.mjs'
		]);
	});
});

// A set-up device always downloaded the answer library, and a document's first save always stores it, so a model
// file or a saved document means this device kept a library. Such a device gets the current pair at install, while
// online, instead of being asked to set up again (the model is still held) and losing offline answers until it does.
// It is owed whether or not an earlier pair is still held: activate prunes the earlier one.
describe('answerLibraryToRestore (the answer library a device keeps through an update)', () => {
	const SHIPPED = [
		'/_app/immutable/entry/start.js',
		'/corpus/corpus-v1.0.3.json',
		'/corpus/corpus-v1.0.3.embeddings.bin',
		'/docs/tap_va101.0f650528.pdf'
	];
	const MODEL = '/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx';
	const WASM = '/wasm/ort-wasm-simd-threaded.asyncify.wasm';
	const DOCUMENT = '/docs/tap_va101.0f650528.pdf';
	const OLD = ['/corpus/corpus-v1.0.2.json', '/corpus/corpus-v1.0.2.embeddings.bin'];
	const NEW = ['/corpus/corpus-v1.0.3.json', '/corpus/corpus-v1.0.3.embeddings.bin'];

	it('returns the shipped library when an earlier one is held', () => {
		expect(answerLibraryToRestore([...OLD, MODEL], SHIPPED)).toEqual(NEW);
	});

	it('returns the shipped library to a set-up device that holds no library file at all', () => {
		expect(answerLibraryToRestore([MODEL, WASM], SHIPPED)).toEqual(NEW);
	});

	it('returns the shipped library to a device that saved a document and holds no library file', () => {
		expect(answerLibraryToRestore([DOCUMENT], SHIPPED)).toEqual(NEW);
	});

	it('returns only what is missing, and nothing when the shipped library is held', () => {
		expect(answerLibraryToRestore([MODEL, NEW[0] ?? ''], SHIPPED)).toEqual([NEW[1]]);
		expect(answerLibraryToRestore([MODEL, NEW[1] ?? ''], SHIPPED)).toEqual([NEW[0]]);
		expect(answerLibraryToRestore([...OLD, NEW[0] ?? '', MODEL], SHIPPED)).toEqual([NEW[1]]);
		expect(answerLibraryToRestore([...NEW, MODEL], SHIPPED)).toEqual([]);
		expect(answerLibraryToRestore([...NEW, DOCUMENT], SHIPPED)).toEqual([]);
	});

	// A device that kept nothing never asked for the library, so an update downloads nothing for it.
	it('returns nothing on a fresh device, and on one that holds only the runtime', () => {
		expect(answerLibraryToRestore([], SHIPPED)).toEqual([]);
		expect(answerLibraryToRestore([WASM], SHIPPED)).toEqual([]);
	});

	// The worker also keeps the library when a page merely reads it - "Read more" on an online answer, a document's
	// text. That device never set up on-device answers or saved a document, so it never asked to keep 7.3 MB, and
	// a release downloads nothing for it, whichever release's library it holds.
	it('returns nothing when the library was kept only by reading', () => {
		expect(answerLibraryToRestore(OLD, SHIPPED)).toEqual([]);
		expect(answerLibraryToRestore([NEW[0] ?? ''], SHIPPED)).toEqual([]);
	});

	it('returns only library files, never another shipped file the device lacks', () => {
		expect(answerLibraryToRestore([MODEL], SHIPPED)).not.toContain(DOCUMENT);
		expect(answerLibraryToRestore([MODEL], SHIPPED)).not.toContain(
			'/_app/immutable/entry/start.js'
		);
	});
});

// The restore runs while an update installs, so one stalled download must not hold the update open, and one
// library failing must not cost the device the other. Time is driven with fake timers: no test waits real seconds.
describe('restoreLibraries (each library gets one try within its own deadline)', () => {
	const ORIGIN = 'https://ask214.com';
	const DEADLINE = 1_000;
	const MODEL = '/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx';
	const DOCUMENT = '/docs/tap_va101.0f650528.pdf';
	const OLD_ANSWERS = ['/corpus/corpus-v1.0.1.json', '/corpus/corpus-v1.0.1.embeddings.bin'];
	const NEW_ANSWERS = ['/corpus/corpus-v1.0.2.json', '/corpus/corpus-v1.0.2.embeddings.bin'];
	const PDF_LIBRARY = ['/pdf-worker/6.4.0/pdf.min.mjs', '/pdf-worker/6.4.0/pdf.worker.min.mjs'];
	const SHIPPED = ['/_app/immutable/entry/start.js', ...NEW_ANSWERS, DOCUMENT, ...PDF_LIBRARY];
	// A saved document and an earlier answer library on a device that set up on-device answers: both libraries are owed.
	const OWING_BOTH = [MODEL, DOCUMENT, ...OLD_ANSWERS];

	/** A cache holding the given paths, which records what is stored; a write for a path `failPut` names fails. */
	function heldCache(held: string[], failPut: (path: string) => boolean = () => false) {
		const stored = new Map<string, string>();
		const cache = {
			async keys() {
				return held.map((path) => new Request(`${ORIGIN}${path}`));
			},
			async put(request: string, response: Response) {
				if (failPut(request)) throw new DOMException('full', 'QuotaExceededError');
				stored.set(request, await response.text());
			}
		};
		return { cache: cache as unknown as Pick<Cache, 'keys' | 'put'>, stored };
	}

	/** A fetch that answers each path as `answer` says, and is told the signal it was given, as the real one is. */
	function fetching(answer: (path: string, signal: AbortSignal) => Promise<Response>) {
		return vi.fn((path: string, init: { signal: AbortSignal }) => answer(path, init.signal));
	}

	/** Never settles by itself; rejects when its signal aborts, as a real fetch does. */
	function stalled(signal: AbortSignal): Promise<Response> {
		return new Promise<Response>((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
		});
	}

	const ok = (path: string) => Promise.resolve(new Response(`bytes of ${path}`));

	it('abandons a library whose download stalls at the deadline, and still stores the next one', async () => {
		vi.useFakeTimers();
		try {
			const { cache, stored } = heldCache(OWING_BOTH);
			const fetchLibrary = fetching((path, signal) =>
				path.startsWith('/pdf-worker/') ? stalled(signal) : ok(path)
			);
			let settled = false;
			const done = restoreLibraries(cache, fetchLibrary, ORIGIN, SHIPPED, DEADLINE).then(() => {
				settled = true;
			});

			// One tick short of the deadline the PDF library is still being waited on, so the answer library has not started.
			await vi.advanceTimersByTimeAsync(DEADLINE - 1);
			expect(fetchLibrary.mock.calls.map(([path]) => path)).toEqual([PDF_LIBRARY[0]]);
			expect(settled).toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			// Checked before awaiting, so a restore that never gives up fails here instead of hanging the test.
			expect(settled).toBe(true);
			await done;
			expect([...stored.keys()]).toEqual(NEW_ANSWERS);
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives each library its own full deadline', async () => {
		vi.useFakeTimers();
		try {
			const { cache, stored } = heldCache(OWING_BOTH);
			const fetchLibrary = fetching((_path, signal) => stalled(signal));
			let settled = false;
			const done = restoreLibraries(cache, fetchLibrary, ORIGIN, SHIPPED, DEADLINE).then(() => {
				settled = true;
			});

			await vi.advanceTimersByTimeAsync(DEADLINE);
			// The answer library began only when the PDF library was abandoned, and has its whole deadline still.
			expect(fetchLibrary.mock.calls.map(([path]) => path)).toEqual([
				PDF_LIBRARY[0],
				NEW_ANSWERS[0]
			]);
			await vi.advanceTimersByTimeAsync(DEADLINE - 1);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(settled).toBe(true);
			await done;
			expect(stored.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives every fetch of a library the same signal, and stops at the first miss in it', async () => {
		vi.useFakeTimers();
		try {
			// The answer library is held, so only the PDF library is owed and its two fetches are the only ones.
			const { cache, stored } = heldCache([MODEL, DOCUMENT, ...NEW_ANSWERS]);
			const fetchLibrary = fetching((path, signal) =>
				path === PDF_LIBRARY[1] ? stalled(signal) : ok(path)
			);
			let settled = false;
			const done = restoreLibraries(cache, fetchLibrary, ORIGIN, SHIPPED, DEADLINE).then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(DEADLINE);
			expect(settled).toBe(true);
			await done;

			const signals = fetchLibrary.mock.calls.map(([, init]) => init.signal);
			expect(signals).toHaveLength(2);
			expect(signals[0]).toBe(signals[1]);
			expect(signals[0]?.aborted).toBe(true);
			expect([...stored.keys()]).toEqual([PDF_LIBRARY[0]]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('leaves no timer running once the libraries are done', async () => {
		vi.useFakeTimers();
		try {
			const { cache } = heldCache(OWING_BOTH);
			await restoreLibraries(cache, fetching(ok), ORIGIN, SHIPPED, DEADLINE);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stores the answer library when the PDF library fails, and the PDF library when the answer library fails', async () => {
		const failing = (prefix: string) =>
			fetching((path) =>
				path.startsWith(prefix) ? Promise.reject(new TypeError('offline')) : ok(path)
			);

		const pdfFails = heldCache(OWING_BOTH);
		await restoreLibraries(pdfFails.cache, failing('/pdf-worker/'), ORIGIN, SHIPPED, DEADLINE);
		expect([...pdfFails.stored.keys()]).toEqual(NEW_ANSWERS);

		const answersFail = heldCache(OWING_BOTH);
		await restoreLibraries(answersFail.cache, failing('/corpus/'), ORIGIN, SHIPPED, DEADLINE);
		expect([...answersFail.stored.keys()]).toEqual(PDF_LIBRARY);
	});

	it('stores the other library when a cache write fails, and never throws', async () => {
		const { cache, stored } = heldCache(OWING_BOTH, (path) => path.startsWith('/pdf-worker/'));
		await expect(
			restoreLibraries(cache, fetching(ok), ORIGIN, SHIPPED, DEADLINE)
		).resolves.toBeUndefined();
		expect([...stored.keys()]).toEqual(NEW_ANSWERS);
	});

	it('never throws when the cache cannot be read', async () => {
		const cache = {
			keys: () => Promise.reject(new Error('unreadable')),
			put: vi.fn()
		} as unknown as Pick<Cache, 'keys' | 'put'>;
		const fetchLibrary = fetching(ok);
		await expect(
			restoreLibraries(cache, fetchLibrary, ORIGIN, SHIPPED, DEADLINE)
		).resolves.toBeUndefined();
		expect(fetchLibrary).not.toHaveBeenCalled();
	});

	it('stores a response only when its status is 200', async () => {
		const { cache, stored } = heldCache(OWING_BOTH);
		const fetchLibrary = fetching((path) =>
			Promise.resolve(
				path === PDF_LIBRARY[0]
					? new Response('missing', { status: 404 })
					: path === NEW_ANSWERS[0]
						? new Response('busy', { status: 503 })
						: new Response(`bytes of ${path}`)
			)
		);
		await restoreLibraries(cache, fetchLibrary, ORIGIN, SHIPPED, DEADLINE);
		expect(fetchLibrary).toHaveBeenCalledTimes(4);
		expect([...stored.keys()]).toEqual([PDF_LIBRARY[1], NEW_ANSWERS[1]]);
	});

	it('fetches nothing when nothing is owed', async () => {
		for (const held of [
			// A fresh device, and one that only read the library.
			[],
			[...OLD_ANSWERS],
			[MODEL, ...NEW_ANSWERS, DOCUMENT, ...PDF_LIBRARY]
		]) {
			const { cache, stored } = heldCache(held);
			const fetchLibrary = fetching(ok);
			await restoreLibraries(cache, fetchLibrary, ORIGIN, SHIPPED, DEADLINE);
			expect(fetchLibrary, held.join(' ')).not.toHaveBeenCalled();
			expect(stored.size).toBe(0);
		}
	});

	it('stores the current answer library for a set-up device that holds none, and for a saving one', async () => {
		for (const held of [[MODEL], [DOCUMENT, ...PDF_LIBRARY]]) {
			const { cache, stored } = heldCache(held);
			await restoreLibraries(cache, fetching(ok), ORIGIN, SHIPPED, DEADLINE);
			expect([...stored.keys()], held.join(' ')).toEqual(NEW_ANSWERS);
		}
	});

	// The retry after activation starts only after the activate prune has run, so on a nearly full device the earlier
	// pair - which the new release cannot read - must already be gone when the new one is written, or it would block
	// it for good. (The install-time attempt runs before any prune and can fail for lack of room; this models the retry.)
	describe('on a device with room for one answer library', () => {
		const FILE_BYTES = 50;
		const MODEL_BYTES = 100;

		/** A cache with `quota` bytes of room; a write that would pass it fails, as a full device's does. */
		function cacheWithRoom(quota: number, held: Record<string, number>) {
			const sizes = new Map(Object.entries(held));
			const used = () => [...sizes.values()].reduce((sum, size) => sum + size, 0);
			const cache = {
				async keys() {
					return [...sizes.keys()].map((path) => new Request(`${ORIGIN}${path}`));
				},
				async put(path: string, response: Response) {
					const size = (await response.arrayBuffer()).byteLength;
					if (used() - (sizes.get(path) ?? 0) + size > quota)
						throw new DOMException('full', 'QuotaExceededError');
					sizes.set(path, size);
				},
				async delete(request: Request) {
					return sizes.delete(new URL(request.url).pathname);
				}
			};
			return { cache, paths: () => [...sizes.keys()] };
		}

		/** What activate does to the cache before the restore: delete every entry the build no longer ships. */
		async function prune(cache: ReturnType<typeof cacheWithRoom>['cache']) {
			for (const request of await cache.keys()) {
				if (isSupersededVersionedEntry(new URL(request.url).pathname, SHIPPED))
					await cache.delete(request);
			}
		}

		const bytes = () => Promise.resolve(new Response('x'.repeat(FILE_BYTES)));
		const held = {
			[MODEL]: MODEL_BYTES,
			[OLD_ANSWERS[0] ?? '']: FILE_BYTES,
			[OLD_ANSWERS[1] ?? '']: FILE_BYTES
		};
		const QUOTA = MODEL_BYTES + 2 * FILE_BYTES;

		it('stores the current pair once the prune has freed the earlier one', async () => {
			const { cache, paths } = cacheWithRoom(QUOTA, held);
			await prune(cache);
			await restoreLibraries(
				cache as unknown as Pick<Cache, 'keys' | 'put'>,
				fetching(bytes),
				ORIGIN,
				SHIPPED,
				DEADLINE
			);
			expect(paths()).toEqual([MODEL, ...NEW_ANSWERS]);
		});

		// The guard against a vacuous pass: with the earlier pair still held the same device cannot take the new one.
		it('cannot store it while the earlier pair is still held', async () => {
			const { cache, paths } = cacheWithRoom(QUOTA, held);
			await restoreLibraries(
				cache as unknown as Pick<Cache, 'keys' | 'put'>,
				fetching(bytes),
				ORIGIN,
				SHIPPED,
				DEADLINE
			);
			expect(paths()).toEqual([MODEL, ...OLD_ANSWERS]);
		});
	});

	// Headers arrive at once and the body then stops: the stall a timer cleared when the last fetch resolved would miss.
	it('abandons an answer library whose body stalls after its headers arrive, and stores nothing', async () => {
		vi.useFakeTimers();
		try {
			// One file of the pair is held, so the stalled one is the last file the library fetches.
			const { cache, stored } = heldCache([MODEL, NEW_ANSWERS[0] ?? '']);
			const fetchLibrary = fetching((_path, signal) =>
				Promise.resolve(
					new Response(
						new ReadableStream({
							start(controller) {
								signal.addEventListener('abort', () =>
									controller.error(new DOMException('aborted', 'AbortError'))
								);
							}
						}),
						{ status: 200 }
					)
				)
			);
			let settled = false;
			const done = restoreLibraries(cache, fetchLibrary, ORIGIN, SHIPPED, DEADLINE).then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(DEADLINE - 1);
			expect(fetchLibrary.mock.calls.map(([path]) => path)).toEqual([NEW_ANSWERS[1]]);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(settled).toBe(true);
			await done;
			expect(stored.size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('reads only this origin: an entry held for another origin is nothing owed', async () => {
		const cache = {
			async keys() {
				return [new Request(`https://elsewhere.example${DOCUMENT}`)];
			},
			put: vi.fn()
		} as unknown as Pick<Cache, 'keys' | 'put'>;
		const fetchLibrary = fetching(ok);
		await restoreLibraries(cache, fetchLibrary, ORIGIN, SHIPPED, DEADLINE);
		expect(fetchLibrary).not.toHaveBeenCalled();
	});
});

// The build list the service worker precaches leaves out the embed worker's script, so the only place this release
// names it is the page code that starts the worker. Install reads the name from there.
describe('workerScriptsNamed (the worker scripts a built chunk starts)', () => {
	const NODE = '/_app/immutable/nodes/2.CrZheqGl.js';
	const SCRIPT = '/_app/immutable/workers/embed-worker-BIZt0I_P.js';
	// Cut from the built chunk that starts the embed worker.
	const BUILT =
		'new Worker(``+new URL(`../workers/embed-worker-BIZt0I_P.js`,import.meta.url).href,{name:e?.name';

	it('resolves the literal against the chunk that holds it, as new URL(literal, import.meta.url) does', () => {
		expect(workerScriptsNamed(NODE, BUILT)).toEqual([SCRIPT]);
		// The same text in a chunk one folder deeper resolves to another path: the chunk's own place is the base.
		expect(workerScriptsNamed('/_app/immutable/nodes/deeper/2.X.js', BUILT)).toEqual([]);
	});

	it('names no worker for a chunk that names a worker asset, or none at all', () => {
		expect(
			workerScriptsNamed(
				NODE,
				'new URL(`../workers/assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm`,import.meta.url)'
			)
		).toEqual([]);
		expect(
			workerScriptsNamed(NODE, 'new URL(`../workers/assets/helper-A1.js`,import.meta.url)')
		).toEqual([]);
		expect(workerScriptsNamed(NODE, 'export const a=1;')).toEqual([]);
	});

	it('names every worker a chunk starts, each once', () => {
		const text = `${BUILT};new URL("../workers/other-Q9.js",import.meta.url);new URL('../workers/embed-worker-BIZt0I_P.js',import.meta.url)`;
		expect(workerScriptsNamed(NODE, text)).toEqual([SCRIPT, '/_app/immutable/workers/other-Q9.js']);
	});

	it('keeps only paths under the worker folder', () => {
		expect(
			workerScriptsNamed(NODE, 'new URL(`../../elsewhere/workers/x-1.js`,import.meta.url)')
		).toEqual([]);
	});

	// An encoded separator stays inside one path segment when a URL is resolved, so only the characters Vite uses in a
	// worker's file name are taken as a script's name.
	it('refuses a name with an encoded separator or a dot-segment in it', () => {
		for (const name of ['..%2f..%2fx.js', '%2e%2e%2fx.js', '..%2Fx.js', 'a.b.js', 'x%00.js']) {
			expect(
				workerScriptsNamed(NODE, `new URL("../workers/${name}",import.meta.url)`),
				name
			).toEqual([]);
		}
		expect(workerScriptsNamed(NODE, 'new URL("../workers/a_b-C1.js",import.meta.url)')).toEqual([
			'/_app/immutable/workers/a_b-C1.js'
		]);
	});
});

describe('keepWorkerScripts (the embed worker script, kept for a device that set up on-device answers)', () => {
	const ORIGIN = 'https://ask214.com';
	const DEADLINE = 1_000;
	const MODEL = '/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx';
	const NODE = '/_app/immutable/nodes/2.CrZheqGl.js';
	const SCRIPT = '/_app/immutable/workers/embed-worker-BIZt0I_P.js';
	const OTHER = '/_app/immutable/workers/other-Q9.js';
	const NAMES_SCRIPT =
		'new Worker(new URL(`../workers/embed-worker-BIZt0I_P.js`,import.meta.url).href)';
	const RELEASE = {
		[NODE]: NAMES_SCRIPT,
		'/_app/immutable/entry/start.js': 'export{}',
		'/': '<html>'
	};

	const pathOf = (request: Request | string) =>
		new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;

	/** The asset cache holding the given paths. */
	function assetsHolding(paths: string[], origin = ORIGIN) {
		return {
			async keys() {
				return paths.map((path) => new Request(`${origin}${path}`));
			}
		} as unknown as Pick<Cache, 'keys'>;
	}

	/** The release cache holding the given path-to-text entries, which records what is stored into it. */
	function releaseHolding(entries: Record<string, string>) {
		const held = new Map(Object.entries(entries));
		const cache = {
			async keys() {
				return [...held.keys()].map((path) => new Request(`${ORIGIN}${path}`));
			},
			async match(request: Request | string) {
				const text = held.get(pathOf(request));
				return text === undefined ? undefined : new Response(text);
			},
			async put(request: Request | string, response: Response) {
				held.set(pathOf(request), await response.text());
			}
		};
		return {
			cache: cache as unknown as Pick<Cache, 'keys' | 'match' | 'put'>,
			stored: () => [...held.keys()].filter((path) => !(path in entries))
		};
	}

	const fetching = (answer: (path: string, signal: AbortSignal) => Promise<Response>) =>
		vi.fn((path: string, init: { signal: AbortSignal }) => answer(path, init.signal));
	const ok = (path: string) => Promise.resolve(new Response(`bytes of ${path}`));

	it('fetches and stores the script a set-up device lacks', async () => {
		const release = releaseHolding(RELEASE);
		const fetchScript = fetching(ok);
		await keepWorkerScripts(assetsHolding([MODEL]), release.cache, fetchScript, ORIGIN, DEADLINE);
		expect(fetchScript.mock.calls.map(([path]) => path)).toEqual([SCRIPT]);
		expect(release.stored()).toEqual([SCRIPT]);
	});

	it('fetches nothing for a device that did not set up on-device answers', async () => {
		for (const held of [[], ['/corpus/corpus-v1.0.2.json', '/docs/tap_va101.0f650528.pdf']]) {
			const release = releaseHolding(RELEASE);
			const fetchScript = fetching(ok);
			await keepWorkerScripts(assetsHolding(held), release.cache, fetchScript, ORIGIN, DEADLINE);
			expect(fetchScript, held.join(' ')).not.toHaveBeenCalled();
			expect(release.stored()).toEqual([]);
		}
	});

	it('reads only this origin: a model held for another origin is not a set-up device', async () => {
		const fetchScript = fetching(ok);
		await keepWorkerScripts(
			assetsHolding([MODEL], 'https://elsewhere.example'),
			releaseHolding(RELEASE).cache,
			fetchScript,
			ORIGIN,
			DEADLINE
		);
		expect(fetchScript).not.toHaveBeenCalled();
	});

	it('does not fetch a script the release cache already holds', async () => {
		const release = releaseHolding({ ...RELEASE, [SCRIPT]: 'kept' });
		const fetchScript = fetching(ok);
		await keepWorkerScripts(assetsHolding([MODEL]), release.cache, fetchScript, ORIGIN, DEADLINE);
		expect(fetchScript).not.toHaveBeenCalled();
	});

	it('stores a response only when its status is 200', async () => {
		const release = releaseHolding(RELEASE);
		const fetchScript = fetching(() => Promise.resolve(new Response('missing', { status: 404 })));
		await keepWorkerScripts(assetsHolding([MODEL]), release.cache, fetchScript, ORIGIN, DEADLINE);
		expect(fetchScript).toHaveBeenCalledTimes(1);
		expect(release.stored()).toEqual([]);
	});

	it('still stores a second script when the first fails, and never throws', async () => {
		const release = releaseHolding({
			...RELEASE,
			'/_app/immutable/nodes/3.Y.js':
				'new Worker(new URL(`../workers/other-Q9.js`,import.meta.url))'
		});
		const fetchScript = fetching((path) =>
			path === SCRIPT ? Promise.reject(new TypeError('offline')) : ok(path)
		);
		await expect(
			keepWorkerScripts(assetsHolding([MODEL]), release.cache, fetchScript, ORIGIN, DEADLINE)
		).resolves.toBeUndefined();
		expect(release.stored()).toEqual([OTHER]);
	});

	it('never throws when a cache cannot be read', async () => {
		const unreadable = { keys: () => Promise.reject(new Error('unreadable')) } as unknown as Pick<
			Cache,
			'keys'
		>;
		const fetchScript = fetching(ok);
		await expect(
			keepWorkerScripts(unreadable, releaseHolding(RELEASE).cache, fetchScript, ORIGIN, DEADLINE)
		).resolves.toBeUndefined();
		await expect(
			keepWorkerScripts(
				assetsHolding([MODEL]),
				{ ...releaseHolding(RELEASE).cache, keys: () => Promise.reject(new Error('unreadable')) },
				fetchScript,
				ORIGIN,
				DEADLINE
			)
		).resolves.toBeUndefined();
		expect(fetchScript).not.toHaveBeenCalled();
	});

	it('abandons a stalled download at the deadline', async () => {
		vi.useFakeTimers();
		try {
			const release = releaseHolding(RELEASE);
			const fetchScript = fetching(
				(_path, signal) =>
					new Promise<Response>((_resolve, reject) => {
						signal.addEventListener('abort', () =>
							reject(new DOMException('aborted', 'AbortError'))
						);
					})
			);
			let settled = false;
			const done = keepWorkerScripts(
				assetsHolding([MODEL]),
				release.cache,
				fetchScript,
				ORIGIN,
				DEADLINE
			).then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(DEADLINE - 1);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(settled).toBe(true);
			await done;
			expect(release.stored()).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	// Headers arrive at once and the body then stops: the stall a timer cleared when the fetch resolved would miss.
	it('abandons a download that stalls after its headers arrive, and stores nothing', async () => {
		vi.useFakeTimers();
		try {
			const release = releaseHolding(RELEASE);
			const fetchScript = fetching((_path, signal) =>
				Promise.resolve(
					new Response(
						new ReadableStream({
							start(controller) {
								signal.addEventListener('abort', () =>
									controller.error(new DOMException('aborted', 'AbortError'))
								);
							}
						}),
						{ status: 200 }
					)
				)
			);
			let settled = false;
			const done = keepWorkerScripts(
				assetsHolding([MODEL]),
				release.cache,
				fetchScript,
				ORIGIN,
				DEADLINE
			).then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(DEADLINE - 1);
			expect(fetchScript).toHaveBeenCalledTimes(1);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(settled).toBe(true);
			await done;
			expect(release.stored()).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	// Activation calls this again for a script install could not store, so the second call must finish the job and
	// the third, with the script held, must cost nothing.
	it('stores on a retry what the first try could not, and fetches nothing once it is held', async () => {
		const release = releaseHolding(RELEASE);
		const offline = fetching(() => Promise.reject(new TypeError('offline')));
		await keepWorkerScripts(assetsHolding([MODEL]), release.cache, offline, ORIGIN, DEADLINE);
		expect(release.stored()).toEqual([]);

		const online = fetching(ok);
		await keepWorkerScripts(assetsHolding([MODEL]), release.cache, online, ORIGIN, DEADLINE);
		expect(release.stored()).toEqual([SCRIPT]);

		const again = fetching(ok);
		await keepWorkerScripts(assetsHolding([MODEL]), release.cache, again, ORIGIN, DEADLINE);
		expect(again).not.toHaveBeenCalled();
	});
});

// Activate deletes what the build no longer ships, the answer library's earlier pairs included: a set-up device is
// owed the current pair (`answerLibraryToRestore`) whether or not it still holds an earlier one, and an earlier pair
// is unreadable to this release, so keeping it would only fill the device - more with every release.
describe('the activate prune (every entry isSupersededVersionedEntry marks, and nothing else)', () => {
	const MODEL = '/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx';
	const WASM = '/wasm/ort-wasm-simd-threaded.asyncify.wasm';
	const DOCUMENT = '/docs/tap_va101.0f650528.pdf';
	const OLDEST = ['/corpus/corpus-v1.0.json', '/corpus/corpus-v1.0.embeddings.bin'];
	const OLD = ['/corpus/corpus-v1.0.1.json', '/corpus/corpus-v1.0.1.embeddings.bin'];
	const NEW = ['/corpus/corpus-v1.0.2.json', '/corpus/corpus-v1.0.2.embeddings.bin'];
	const OLD_PDF = ['/pdf-worker/6.3.289/pdf.min.mjs', '/pdf-worker/6.3.289/pdf.worker.min.mjs'];
	const SHIPPED = [
		'/_app/immutable/entry/start.js',
		...NEW,
		DOCUMENT,
		'/models/Xenova/all-MiniLM-L6-v2/config.json',
		'/wasm/ort-wasm-simd-threaded.asyncify.mjs',
		'/pdf-worker/6.4.0/pdf.min.mjs',
		'/pdf-worker/6.4.0/pdf.worker.min.mjs'
	];
	const marked = (cached: string[]) =>
		cached.filter((path) => isSupersededVersionedEntry(path, SHIPPED));

	it('marks an earlier answer library whatever the device holds beside it', () => {
		expect(marked([MODEL, ...OLD])).toEqual(OLD);
		expect(marked([DOCUMENT, ...OLD])).toEqual(OLD);
		expect(marked([...OLD])).toEqual(OLD);
		expect(marked([MODEL, ...OLD, ...NEW])).toEqual(OLD);
		expect(marked([MODEL, ...OLD, NEW[0] ?? ''])).toEqual(OLD);
	});

	it('marks the pairs of every earlier release, so none piles up', () => {
		expect(marked([MODEL, ...OLDEST, ...OLD, ...NEW])).toEqual([...OLDEST, ...OLD]);
	});

	it('marks a superseded PDF library too', () => {
		expect(marked([DOCUMENT, ...OLD_PDF, MODEL, ...OLD])).toEqual([...OLD_PDF, ...OLD]);
	});

	it('never marks the model or the WASM, or a saved document whose source still ships', () => {
		const older = '/docs/tap_va101.0badc0de.pdf';
		expect(marked([MODEL, WASM, '/models/e2e-prune-probe.onnx', older, DOCUMENT, ...OLD])).toEqual(
			OLD
		);
	});
});

// The worker keeps a fetched model, WASM or corpus file as it passes through. The write must outlive the
// fetch - the browser may stop an idle worker the moment the response is handed over - so it runs under the
// fetch event's waitUntil; and a write that fails, a full disk above all, must not surface as an unhandled
// failure: the response was already served, and the next request fetches and tries again.
describe('storeOnFetch', () => {
	function writeInto(put: (request: Request, response: Response) => Promise<void>) {
		const waited: Promise<unknown>[] = [];
		const event = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise) };
		const cache = { put } as unknown as Cache;
		const request = new Request('https://app.test/models/model.onnx');
		const response = new Response('bytes');
		storeOnFetch(event, cache, request, response);
		return { waited, response };
	}

	it('keeps the worker alive until the write lands, storing a copy so the response itself stays unread', async () => {
		const put = vi.fn(async (_request: Request, stored: Response) => {
			await stored.text();
		});
		const { waited, response } = writeInto(put);

		expect(waited).toHaveLength(1);
		await waited[0];
		expect(put).toHaveBeenCalledTimes(1);
		expect(put.mock.calls[0]?.[1]).not.toBe(response);
		expect(await response.text()).toBe('bytes');
	});

	it('lets a write that fails end quietly instead of as an unhandled failure', async () => {
		const { waited } = writeInto(async () => {
			throw new DOMException('full', 'QuotaExceededError');
		});

		expect(waited).toHaveLength(1);
		await expect(waited[0]).resolves.toBeUndefined();
	});

	// The app page kept at install must stay the one its own release installed: a visit online during an update
	// fetches the NEW release's page, and storing it in the old release's cache would serve, offline, a page naming
	// files that cache does not hold. So a held copy stands; with none held (after an erase), a visit keeps one.
	it('keeps the app page install stored, and stores one only when none is held', async () => {
		for (const held of [true, false]) {
			const put = vi.fn(async () => {});
			const match = vi.fn(async () => (held ? new Response('install copy') : undefined));
			const waited: Promise<unknown>[] = [];
			const event = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise) };
			const cache = { put, match } as unknown as Cache;
			storeOnFetch(event, cache, new Request(`https://app.test${APP_SHELL}`), new Response('page'));
			await waited[0];
			expect(put, `held: ${held}`).toHaveBeenCalledTimes(held ? 0 : 1);
		}
	});
});

// The model and the ORT WASM are served at fixed URLs and kept in the asset cache for good: a returning device
// never asks for them again, so bytes vendored anew reach it only if the cache's name changes as well. Each
// name is pinned to the digest of the vendored folders. Changing bytes a device keeps fails here until the cache
// takes a new name - add a line for the new name, and keep the old one as the record of what that name held. The
// digest also moves when a file no device ever requested is removed, which reaches no device: nothing needs
// fetching again, so that case re-pins the same name to the new digest.
const VENDORED_BYTES: Record<string, string> = {
	'ask-assets-v1': '214663e52ef03af7c450efa53b0f4ea32cb2ef61c470cc33ec2e2803ccc4d8d7'
};

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? filesUnder(posix.join(dir, entry.name)) : [posix.join(dir, entry.name)]
	);
}

function vendoredDigest(): string {
	const hash = createHash('sha256');
	for (const file of [...filesUnder('static/wasm'), ...filesUnder('static/models')].sort()) {
		hash.update(`${file}\0`);
		hash.update(readFileSync(file));
	}
	return hash.digest('hex');
}

describe('the asset cache name and the vendored bytes it holds', () => {
	it('names the cache after the model and WASM bytes it keeps', () => {
		expect(VENDORED_BYTES[ASK_ASSET_CACHE]).toBe(vendoredDigest());
	});
});

// A navigation that fails offline gets the page kept for its address, else the page the worker keeps at install,
// which draws any top-level page. Any other request gets only its own kept answer.
describe('offlineResponse', () => {
	function cacheHolding(entries: Record<string, string>) {
		const match = vi.fn(async (request: RequestInfo | URL) => {
			const path =
				request instanceof URL
					? request.pathname
					: typeof request === 'string'
						? request
						: new URL(request.url).pathname;
			return path in entries ? new Response(entries[path]) : undefined;
		});
		return { match };
	}
	// A navigation Request cannot be constructed in script (mode 'navigate' is reserved), so it is described.
	const navigation = (path: string) =>
		({ url: `https://ask214.test${path}`, mode: 'navigate' }) as unknown as Request;

	it('serves the page kept for that address first', async () => {
		const cache = cacheHolding({ '/documents': 'documents page', [APP_SHELL]: 'shell' });
		const answer = await offlineResponse(cache, navigation('/documents'));
		expect(await answer?.text()).toBe('documents page');
	});

	it('serves the page kept at install for an address never kept, ignoring Vary', async () => {
		const cache = cacheHolding({ [APP_SHELL]: 'shell' });
		const answer = await offlineResponse(cache, navigation('/about'));
		expect(await answer?.text()).toBe('shell');
		expect(cache.match).toHaveBeenLastCalledWith(APP_SHELL, { ignoreVary: true });
	});

	it('gives a request that is not a navigation only its own kept answer', async () => {
		const cache = cacheHolding({ [APP_SHELL]: 'shell' });
		const script = new Request('https://ask214.test/_app/immutable/x.js');
		expect(await offlineResponse(cache, script)).toBeUndefined();
	});

	it('returns nothing when neither is kept', async () => {
		expect(await offlineResponse(cacheHolding({}), navigation('/about'))).toBeUndefined();
	});

	// The shell loads its code by relative paths, which resolve only from a top-level address: deeper, it would
	// open as a blank page, so the plain "Offline" answer is the honest one there.
	it('does not answer a nested or trailing-slash address with the shell', async () => {
		const cache = cacheHolding({ [APP_SHELL]: 'shell' });
		expect(await offlineResponse(cache, navigation('/about/'))).toBeUndefined();
		expect(await offlineResponse(cache, navigation('/documents/x'))).toBeUndefined();
	});
});
