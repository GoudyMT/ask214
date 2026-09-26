import { afterEach, describe, it, expect, vi, type Mock } from 'vitest';
import {
	heldBytes,
	isAnswerLibraryHeld,
	isDocumentSaved,
	isPdfLibraryHeld,
	listCachedDocuments,
	removeDocuments,
	runningSave,
	saveDocument,
	savesSettled,
	stopSaves,
	type SaveResult
} from './document-cache';
import { LIBRARY_SRC, WORKER_SRC } from './pdf-library-paths';
import { ASK_ASSET_CACHE } from '$lib/ask/asset-cache';
import { CORPUS_BASE } from '$lib/ask/corpus-load';

const PATH = '/docs/tap_vet_centers.1dcfd966.pdf';

/**
 * A stand-in for the Cache API. It models Vary the way the real one does: an entry the service worker stored
 * - the PDF library a reader loaded online, or a document an older build kept - is keyed on its own fetch
 * request, which carried headers a bare path lookup does not, so a stored response that varies on them is
 * found only when the lookup ignores Vary.
 */
function fakeCaches(held: string[], options: { openThrows?: boolean; matchThrows?: boolean } = {}) {
	const opened: string[] = [];
	const api = {
		async open(name: string) {
			opened.push(name);
			if (options.openThrows) throw new Error('E_TEST_OPEN');
			return {
				async match(path: string, query?: CacheQueryOptions) {
					if (options.matchThrows) throw new Error('E_TEST_MATCH');
					return held.includes(path) && query?.ignoreVary === true
						? new Response('pdf')
						: undefined;
				}
			};
		}
	} as unknown as CacheStorage;
	return { api, opened };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('isDocumentSaved', () => {
	it('reports a document already in the asset cache as saved', async () => {
		const { api } = fakeCaches([PATH]);
		expect(await isDocumentSaved(PATH, api)).toBe(true);
	});

	it('looks in the asset cache where saved documents live, and nowhere else', async () => {
		const { api, opened } = fakeCaches([PATH]);
		await isDocumentSaved(PATH, api);
		expect(opened).toEqual([ASK_ASSET_CACHE]);
	});

	it('reports a document that is not in the cache as not saved', async () => {
		const { api } = fakeCaches(['/docs/other.00000000.pdf']);
		expect(await isDocumentSaved(PATH, api)).toBe(false);
	});

	// Not saved is the safe answer: the reader then asks before downloading, rather than promising offline.
	it('reports not saved when the browser has no Cache API', async () => {
		vi.stubGlobal('caches', undefined);
		expect(await isDocumentSaved(PATH)).toBe(false);
	});

	it('reports not saved when opening the cache throws', async () => {
		const { api } = fakeCaches([PATH], { openThrows: true });
		expect(await isDocumentSaved(PATH, api)).toBe(false);
	});

	it('reports not saved when the lookup throws', async () => {
		const { api } = fakeCaches([PATH], { matchThrows: true });
		expect(await isDocumentSaved(PATH, api)).toBe(false);
	});
});

const ORIGIN = 'https://ask214.test';
const CURRENT = '/docs/tap_vet_centers.1dcfd966.pdf';
const OLD = '/docs/tap_vet_centers.0badc0de.pdf';

/**
 * A Cache API that records every write in order, so a test can tell "the old copy was deleted after the new
 * one was stored" from "both happened". `putError` makes the store fail the way a full disk does, and
 * `putGate` holds each store until it resolves, the way a large write is still going. A lookup finds a held
 * path only when it ignores Vary, as `fakeCaches` models: the worker keeps the PDF library under its own
 * request, whose headers a bare path lookup does not carry.
 */
function recordingCaches(
	options: { held?: string[]; exists?: boolean; putError?: Error; putGate?: Promise<void> } = {}
) {
	const held = new Set(options.held ?? []);
	const log: string[] = [];
	const deleteOptions: (CacheQueryOptions | undefined)[] = [];
	const api = {
		async has(name: string) {
			return name === ASK_ASSET_CACHE && options.exists !== false;
		},
		async open(name: string) {
			log.push(`open ${name}`);
			return {
				async match(path: string, query?: CacheQueryOptions) {
					return held.has(path) && query?.ignoreVary === true ? new Response('held') : undefined;
				},
				async put(path: string, response: Response) {
					await response.arrayBuffer();
					await options.putGate;
					if (options.putError) throw options.putError;
					log.push(`put ${path}`);
					held.add(path);
				},
				async delete(path: string, query?: CacheQueryOptions) {
					log.push(`delete ${path}`);
					deleteOptions.push(query);
					return held.delete(path);
				},
				async keys() {
					return [...held].map(
						(path) => new Request(path.startsWith('http') ? path : ORIGIN + path)
					);
				}
			};
		}
	} as unknown as CacheStorage;
	return { api, log, held, deleteOptions };
}

type FetchLike = (path: string, init?: RequestInit) => Promise<Response>;

function okFetch(body = 'pdf bytes') {
	return vi.fn<FetchLike>(async () => new Response(body, { status: 200 }));
}

const online = () => true;
const offline = () => false;

// These pin the document's own request, store and clean-up, so each runs with no library to store: every
// request and write it sees is the document's. The library step is pinned on its own below.
describe('saveDocument', () => {
	it('stores the document, then deletes its older copies - in that order', async () => {
		const caches = recordingCaches({ held: [OLD] });
		const result = await saveDocument(CURRENT, [OLD], {
			fetchFn: okFetch(),
			cachesApi: caches.api,
			isOnline: online,
			library: []
		});
		expect(result).toBe('saved');
		expect(caches.log.filter((line) => !line.startsWith('open'))).toEqual([
			`put ${CURRENT}`,
			`delete ${OLD}`
		]);
		expect([...caches.held]).toEqual([CURRENT]);
	});

	// A byte-range read of a cached whole file corrupts it, and a save keeps only a whole 200, so the
	// document is always requested whole.
	it('requests the whole file, never a range', async () => {
		const fetchFn = okFetch();
		await saveDocument(CURRENT, [], {
			fetchFn,
			cachesApi: recordingCaches().api,
			isOnline: online,
			library: []
		});
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(fetchFn.mock.calls[0]?.[0]).toBe(CURRENT);
		expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).has('range')).toBe(false);
	});

	it('stores nothing and reports a failure for a response other than 200', async () => {
		const caches = recordingCaches({ held: [OLD] });
		const fetchFn = vi.fn(async () => new Response('partial', { status: 206 }));
		expect(
			await saveDocument(CURRENT, [OLD], {
				fetchFn,
				cachesApi: caches.api,
				isOnline: online,
				library: []
			})
		).toBe('failed');
		expect([...caches.held]).toEqual([OLD]);
	});

	// The older copy is still the user's record of the document; a failed save must not cost them it.
	it('keeps the older copy when storing fails because the device is full', async () => {
		const caches = recordingCaches({
			held: [OLD],
			putError: new DOMException('full', 'QuotaExceededError')
		});
		expect(
			await saveDocument(CURRENT, [OLD], {
				fetchFn: okFetch(),
				cachesApi: caches.api,
				isOnline: online,
				library: []
			})
		).toBe('quota');
		expect([...caches.held]).toEqual([OLD]);
	});

	// The device can report a connection it does not have (Wi-Fi joined, no internet); the failed request is
	// the evidence that counts.
	it('reports offline when the request cannot reach the network, whatever the device reports', async () => {
		const fetchFn = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});
		expect(
			await saveDocument(CURRENT, [], {
				fetchFn,
				cachesApi: recordingCaches().api,
				isOnline: online,
				library: []
			})
		).toBe('offline');
	});

	// With the service worker in control a lost connection is not a rejected fetch: the worker answers 503
	// "Offline" itself. That must still read as offline, not as a broken download.
	it('reports offline when the worker answers for a device that has lost its connection', async () => {
		const caches = recordingCaches();
		const fetchFn = vi.fn(async () => new Response('Offline', { status: 503 }));
		expect(
			await saveDocument(CURRENT, [], {
				fetchFn,
				cachesApi: caches.api,
				isOnline: offline,
				library: []
			})
		).toBe('offline');
		expect([...caches.held]).toEqual([]);
	});

	it('reports stopped, and stores nothing, when the user stops it', async () => {
		const caches = recordingCaches({ held: [OLD] });
		const controller = new AbortController();
		const fetchFn = vi.fn(async (_path: string, init?: RequestInit) => {
			controller.abort();
			init?.signal?.throwIfAborted();
			return new Response('pdf bytes', { status: 200 });
		});
		expect(
			await saveDocument(CURRENT, [OLD], {
				fetchFn,
				cachesApi: caches.api,
				signal: controller.signal,
				isOnline: online,
				library: []
			})
		).toBe('stopped');
		expect([...caches.held]).toEqual([OLD]);
	});

	it('reports a failure, rather than throwing, when the browser has no Cache API', async () => {
		expect(
			await saveDocument(CURRENT, [], {
				fetchFn: okFetch(),
				cachesApi: undefined,
				isOnline: online
			})
		).toBe('failed');
	});
});

/** A fetch that answers 200 for every path except `failing`, which gets what `fail` gives. */
function fetchFailingOn(failing: string, fail: () => Promise<Response>) {
	return vi.fn<FetchLike>(async (path) =>
		path === failing ? fail() : new Response('bytes', { status: 200 })
	);
}

const requested = (fetchFn: Mock<FetchLike>) => fetchFn.mock.calls.map(([path]) => path);
const writes = (log: string[]) => log.filter((line) => !line.startsWith('open'));

// The answer library's two files: the text of every source, and its search vectors, which the text view loads
// with it.
const TEXT = `${CORPUS_BASE}.json`;
const VECTORS = `${CORPUS_BASE}.embeddings.bin`;

// A saved document's Text view reads the answer library - the text of every source - so without it a saved
// document opens offline with no text a screen reader can read. A save stores it too, once, when it is missing.
describe('saveDocument - the answer library that holds the text', () => {
	it('stores the answer library when it is missing, after the PDF library and before the document', async () => {
		const caches = recordingCaches({ held: [LIBRARY_SRC, WORKER_SRC] });
		const fetchFn = okFetch();
		expect(
			await saveDocument(CURRENT, [], { fetchFn, cachesApi: caches.api, isOnline: online })
		).toBe('saved');
		expect(requested(fetchFn)).toEqual([TEXT, VECTORS, CURRENT]);
	});

	it('requests none of it when the device already holds it', async () => {
		const caches = recordingCaches({ held: [LIBRARY_SRC, WORKER_SRC, TEXT, VECTORS] });
		const fetchFn = okFetch();
		expect(
			await saveDocument(CURRENT, [], { fetchFn, cachesApi: caches.api, isOnline: online })
		).toBe('saved');
		expect(requested(fetchFn)).toEqual([CURRENT]);
	});

	it('ends the save before the document when the answer library cannot be stored, keeping the older copy', async () => {
		const caches = recordingCaches({ held: [LIBRARY_SRC, WORKER_SRC, OLD] });
		const fetchFn = fetchFailingOn(TEXT, async () => new Response('gone', { status: 404 }));
		expect(
			await saveDocument(CURRENT, [OLD], { fetchFn, cachesApi: caches.api, isOnline: online })
		).toBe('failed');
		expect(requested(fetchFn)).toEqual([TEXT]);
		expect([...caches.held].sort()).toEqual([LIBRARY_SRC, OLD, WORKER_SRC].sort());
	});
});

// A saved document draws its page offline only when the PDF library is on the device too, and nothing else
// stores the library unless a reader opens a document online. So a save stores the library first. The answer
// library is held in these, so each shows the PDF library alone.
describe('saveDocument - the PDF library that draws the page', () => {
	it('stores the library when it is missing, before the document', async () => {
		const caches = recordingCaches({ held: [OLD, TEXT, VECTORS] });
		const fetchFn = okFetch();
		expect(
			await saveDocument(CURRENT, [OLD], { fetchFn, cachesApi: caches.api, isOnline: online })
		).toBe('saved');
		expect(requested(fetchFn)).toEqual([LIBRARY_SRC, WORKER_SRC, CURRENT]);
		expect(writes(caches.log)).toEqual([
			`put ${LIBRARY_SRC}`,
			`put ${WORKER_SRC}`,
			`put ${CURRENT}`,
			`delete ${OLD}`
		]);
	});

	// The library is shared by every document, so Save all downloads it once, and a save after a reader
	// opened online downloads it not at all.
	it('requests none of the library when both files are held', async () => {
		const caches = recordingCaches({ held: [LIBRARY_SRC, WORKER_SRC, TEXT, VECTORS] });
		const fetchFn = okFetch();
		expect(
			await saveDocument(CURRENT, [], { fetchFn, cachesApi: caches.api, isOnline: online })
		).toBe('saved');
		expect(requested(fetchFn)).toEqual([CURRENT]);
		expect(writes(caches.log)).toEqual([`put ${CURRENT}`]);
	});

	it('requests only the library file that is missing', async () => {
		const caches = recordingCaches({ held: [LIBRARY_SRC, TEXT, VECTORS] });
		const fetchFn = okFetch();
		expect(
			await saveDocument(CURRENT, [], { fetchFn, cachesApi: caches.api, isOnline: online })
		).toBe('saved');
		expect(requested(fetchFn)).toEqual([WORKER_SRC, CURRENT]);
	});

	// Without the library the document opens offline only as text, so a save that could not store it is not a
	// save: it ends the way a failed document request does, before the document is requested, and the older
	// copy stays.
	const failures: {
		result: SaveResult;
		when: string;
		isOnline: () => boolean;
		fail: () => Promise<Response>;
	}[] = [
		{
			result: 'failed',
			when: 'the library is answered with other than 200',
			isOnline: online,
			fail: async () => new Response('gone', { status: 404 })
		},
		{
			result: 'offline',
			when: 'the worker answers the library for a device that has lost its connection',
			isOnline: offline,
			fail: async () => new Response('Offline', { status: 503 })
		},
		{
			result: 'offline',
			when: 'the library request cannot reach the network',
			isOnline: online,
			fail: async () => {
				throw new TypeError('Failed to fetch');
			}
		}
	];
	it.each(failures)('reports $result when $when', async ({ result, isOnline, fail }) => {
		const caches = recordingCaches({ held: [OLD] });
		const fetchFn = fetchFailingOn(LIBRARY_SRC, fail);
		expect(await saveDocument(CURRENT, [OLD], { fetchFn, cachesApi: caches.api, isOnline })).toBe(
			result
		);
		expect(requested(fetchFn)).toEqual([LIBRARY_SRC]);
		expect([...caches.held]).toEqual([OLD]);
	});

	it('reports quota, and keeps the older copy, when the device is too full for the library', async () => {
		const caches = recordingCaches({
			held: [OLD],
			putError: new DOMException('full', 'QuotaExceededError')
		});
		const fetchFn = okFetch();
		expect(
			await saveDocument(CURRENT, [OLD], { fetchFn, cachesApi: caches.api, isOnline: online })
		).toBe('quota');
		expect(requested(fetchFn)).toEqual([LIBRARY_SRC]);
		expect([...caches.held]).toEqual([OLD]);
	});

	it('reports stopped, and stores nothing, when the user stops it during the library', async () => {
		const caches = recordingCaches({ held: [OLD] });
		const controller = new AbortController();
		const fetchFn = vi.fn<FetchLike>(async (path, init) => {
			if (path === LIBRARY_SRC) {
				controller.abort();
				init?.signal?.throwIfAborted();
			}
			return new Response('bytes', { status: 200 });
		});
		expect(
			await saveDocument(CURRENT, [OLD], {
				fetchFn,
				cachesApi: caches.api,
				signal: controller.signal,
				isOnline: online
			})
		).toBe('stopped');
		expect([...caches.held]).toEqual([OLD]);
	});
});

/** Whether `promise` settles before the next task, which is all a promise with nothing left to wait on needs. */
function settlesAtOnce(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0))
	]);
}

// A save whose download has arrived stores it however it is stopped, so clearing the saved documents waits
// for every save still writing, or the document lands after the clear.
describe('savesSettled', () => {
	it('waits for a save still writing, and resolves at once with none in flight', async () => {
		expect(await settlesAtOnce(savesSettled())).toBe(true);

		let open = () => {};
		const caches = recordingCaches({ putGate: new Promise<void>((resolve) => (open = resolve)) });
		const save = saveDocument(CURRENT, [], {
			fetchFn: okFetch(),
			cachesApi: caches.api,
			isOnline: online,
			library: []
		});
		const settled = savesSettled();
		expect(await settlesAtOnce(settled)).toBe(false);
		expect([...caches.held]).toEqual([]);

		open();
		await settled;
		expect([...caches.held]).toEqual([CURRENT]);
		expect(await save).toBe('saved');
		expect(await settlesAtOnce(savesSettled())).toBe(true);
	});
});

// A Save built while its document is already saving - the reader's foot built again in its other place, or the
// Documents list after the reader closes - shows that save rather than offering a second download.
describe('runningSave', () => {
	it("hands back a document's running save, and nothing for another document or once it has ended", async () => {
		expect(runningSave(CURRENT)).toBeUndefined();

		let open = () => {};
		const caches = recordingCaches({ putGate: new Promise<void>((resolve) => (open = resolve)) });
		const save = saveDocument(CURRENT, [], {
			fetchFn: okFetch(),
			cachesApi: caches.api,
			isOnline: online,
			library: []
		});
		// The held write is let through even when a check fails, so no save outlives this test.
		try {
			const running = runningSave(CURRENT);
			expect(running).toBeDefined();
			expect(runningSave(OLD)).toBeUndefined();
			expect(await settlesAtOnce(running as Promise<SaveResult>)).toBe(false);

			open();
			expect(await running).toBe('saved');
		} finally {
			open();
			await save;
		}
		expect(runningSave(CURRENT)).toBeUndefined();
	});
});

// Clearing the saved documents stops every save first, whoever started it, so a slow or stalled download
// cannot hold an erase back, and waits out a write already under way. The stop reaches the saves running at
// that moment and no later one.
describe('stopSaves', () => {
	// A download that never arrives. Like the browser's fetch, it rejects at once on a signal already stopped,
	// and otherwise when the signal stops.
	const stalled = (_path: string, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			const stop = () => reject(new DOMException('stopped', 'AbortError'));
			if (init?.signal?.aborted) stop();
			else init?.signal?.addEventListener('abort', stop);
		});

	it('stops every save still downloading, even one its caller gave no signal', async () => {
		const caches = recordingCaches();
		const running = saveDocument(CURRENT, [], {
			fetchFn: stalled,
			cachesApi: caches.api,
			isOnline: online,
			library: []
		});
		const stopping = stopSaves();
		expect(await settlesAtOnce(running)).toBe(true);
		expect(await running).toBe('stopped');
		expect(await settlesAtOnce(stopping)).toBe(true);
		expect([...caches.held]).toEqual([]);
	});

	// A download that has arrived is stored however its save is stopped: this one ignores the stop, as an arrived
	// download does, and its write is held until the gate opens.
	it('waits for a write already under way, until it has landed', async () => {
		let open = () => {};
		const caches = recordingCaches({ putGate: new Promise<void>((resolve) => (open = resolve)) });
		const save = saveDocument(CURRENT, [], {
			fetchFn: okFetch(),
			cachesApi: caches.api,
			isOnline: online,
			library: []
		});
		const stopping = stopSaves();
		expect(await settlesAtOnce(stopping)).toBe(false);

		open();
		await stopping;
		expect([...caches.held]).toEqual([CURRENT]);
		expect(await save).toBe('saved');
	});

	it('leaves a save started after a stop to run, and a later stop still reaches the saves then running', async () => {
		await stopSaves();
		const caches = recordingCaches();
		const later = saveDocument(CURRENT, [], {
			fetchFn: okFetch(),
			cachesApi: caches.api,
			isOnline: online,
			library: []
		});
		expect(await later).toBe('saved');
		expect([...caches.held]).toEqual([CURRENT]);

		const stalledSave = saveDocument(OLD, [], {
			fetchFn: stalled,
			cachesApi: caches.api,
			isOnline: online,
			library: []
		});
		const stopping = stopSaves();
		expect(await settlesAtOnce(stalledSave)).toBe(true);
		expect(await stalledSave).toBe('stopped');
		await stopping;
	});
});

describe('removeDocuments', () => {
	it('deletes exactly the given paths, matching the way the worker stored them', async () => {
		const caches = recordingCaches({ held: [CURRENT, OLD, '/docs/tap_va101.0f650528.pdf'] });
		await removeDocuments([CURRENT, OLD], caches.api);
		expect([...caches.held]).toEqual(['/docs/tap_va101.0f650528.pdf']);
		expect(caches.deleteOptions).toEqual([{ ignoreVary: true }, { ignoreVary: true }]);
	});
});

describe('listCachedDocuments', () => {
	it('lists the held documents of this origin and nothing else', async () => {
		const caches = recordingCaches({
			held: [
				CURRENT,
				'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
				'/corpus/corpus-v1.0.2.json',
				'https://elsewhere.test/docs/tap_va101.0f650528.pdf'
			]
		});
		expect(await listCachedDocuments(caches.api, ORIGIN)).toEqual([CURRENT]);
	});

	// A read must not create the cache: an install that never fetched a document keeps no empty cache.
	it('lists nothing, and opens nothing, when the cache does not exist', async () => {
		const caches = recordingCaches({ exists: false });
		expect(await listCachedDocuments(caches.api, ORIGIN)).toEqual([]);
		expect(caches.log).toEqual([]);
	});
});

// A document's text comes from the answer library - the corpus Ask searches on the device - and the library is
// two files. Offline, the text opens only when both are held.
describe('isAnswerLibraryHeld', () => {
	const BASE = '/corpus/corpus-v1.0.2';

	it('is true when both of the library files are held', async () => {
		const caches = recordingCaches({ held: [`${BASE}.json`, `${BASE}.embeddings.bin`] });
		expect(await isAnswerLibraryHeld(BASE, caches.api)).toBe(true);
	});

	it('is false when either file is missing', async () => {
		const textOnly = recordingCaches({ held: [`${BASE}.json`] });
		const vectorsOnly = recordingCaches({ held: [`${BASE}.embeddings.bin`] });
		expect(await isAnswerLibraryHeld(BASE, textOnly.api)).toBe(false);
		expect(await isAnswerLibraryHeld(BASE, vectorsOnly.api)).toBe(false);
	});

	// An update prunes an older library, and until the new one is fetched the device holds no current one.
	it('is false when only another version of the library is held', async () => {
		const older = '/corpus/corpus-v1.0.1';
		const caches = recordingCaches({ held: [`${older}.json`, `${older}.embeddings.bin`] });
		expect(await isAnswerLibraryHeld(BASE, caches.api)).toBe(false);
	});

	it('answers no, and opens nothing, when the cache does not exist', async () => {
		const caches = recordingCaches({ exists: false });
		expect(await isAnswerLibraryHeld(BASE, caches.api)).toBe(false);
		expect(caches.log).toEqual([]);
	});

	// No answer is the safe direction: the page then promises nothing it cannot keep.
	it('answers no when the cache cannot be read', async () => {
		const broken = {
			has: async () => {
				throw new Error('E_TEST_CACHE');
			}
		} as unknown as CacheStorage;
		expect(await isAnswerLibraryHeld(BASE, broken)).toBe(false);
	});
});

// An older copy is a version this build no longer ships, so no size table knows it: its size is read from what
// the device stored. Every held copy here is the fake cache's 4-byte body.
describe('heldBytes', () => {
	it('sums the stored size of each held path, and counts nothing for a path not held', async () => {
		const caches = recordingCaches({ held: [OLD, '/docs/tap_va101.0badc0de.pdf'] });
		expect(await heldBytes([OLD, '/docs/tap_va101.0badc0de.pdf'], caches.api)).toBe(8);
		expect(await heldBytes([OLD, '/docs/tap_dol_efct.0badc0de.pdf'], caches.api)).toBe(4);
	});

	it('is 0, and opens nothing, when the cache does not exist', async () => {
		const caches = recordingCaches({ exists: false });
		expect(await heldBytes([OLD], caches.api)).toBe(0);
		expect(caches.log).toEqual([]);
	});

	// No Cache API (some private windows) means nothing can be held, so nothing is counted: that size is known.
	it('is 0 when the browser has no Cache API', async () => {
		vi.stubGlobal('caches', undefined);
		expect(await heldBytes([OLD])).toBe(0);
	});

	// A size the device will not give is unknown, not nothing: the Documents area then leaves it out rather
	// than stating 0.0 MB for a copy it holds.
	it('is null when a held copy cannot be read', async () => {
		const cache = (match: () => Promise<Response | undefined>) =>
			({
				async has() {
					return true;
				},
				async open() {
					return { match };
				}
			}) as unknown as CacheStorage;
		const unreadable = new Response('held');
		vi.spyOn(unreadable, 'blob').mockRejectedValue(
			new DOMException('E_TEST_READ', 'NotReadableError')
		);

		expect(
			await heldBytes(
				[OLD],
				cache(async () => unreadable)
			)
		).toBeNull();
		expect(
			await heldBytes(
				[OLD],
				cache(async () => {
					throw new Error('E_TEST_MATCH');
				})
			)
		).toBeNull();
	});
});

// The page reader is the PDF library and its worker. A first save stores both, so the Save area says so while
// either is missing.
describe('isPdfLibraryHeld', () => {
	it('is true when the library and its worker are both held', async () => {
		const caches = recordingCaches({ held: [LIBRARY_SRC, WORKER_SRC] });
		expect(await isPdfLibraryHeld(caches.api)).toBe(true);
	});

	it('is false when either is missing', async () => {
		expect(await isPdfLibraryHeld(recordingCaches({ held: [LIBRARY_SRC] }).api)).toBe(false);
		expect(await isPdfLibraryHeld(recordingCaches({ held: [WORKER_SRC] }).api)).toBe(false);
	});

	it('answers no, and opens nothing, when the cache does not exist', async () => {
		const caches = recordingCaches({ exists: false });
		expect(await isPdfLibraryHeld(caches.api)).toBe(false);
		expect(caches.log).toEqual([]);
	});
});
