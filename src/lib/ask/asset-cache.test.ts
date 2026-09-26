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
	storeOnFetch,
	carryOverSavedDocuments,
	keptOnActivate
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
			'/wasm/ort-wasm-simd-threaded.wasm'
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
		'/wasm/ort-wasm-simd-threaded.wasm'
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
			'/wasm/ort-wasm-simd-threaded.wasm'
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
			'/wasm/ort-wasm-simd-threaded.wasm'
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
			'/wasm/ort-wasm-simd-threaded.wasm'
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
				'/wasm/ort-wasm-simd-threaded.wasm': 'wasm'
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
});

// The model and the ORT WASM are served at fixed URLs and kept in the asset cache for good: a returning device
// never asks for them again, so bytes vendored anew reach it only if the cache's name changes as well. Each
// name is pinned to the digest of the bytes it holds. Changing those bytes fails here until the cache takes a
// new name - add a line for the new name, and keep the old one as the record of what that name held.
const VENDORED_BYTES: Record<string, string> = {
	'ask-assets-v1': 'e34ba4ce08d953a419ffe5c595fe4c5b8017300fdd5745ef467a7e1b2f50b708'
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
