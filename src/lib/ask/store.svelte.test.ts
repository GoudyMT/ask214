import { describe, it, expect, beforeEach } from 'vitest';
import { createAskStore } from './store.svelte';
import { AskError, ASK_ERROR } from './errors';
import type { Corpus, CorpusChunk } from '$lib/corpus';

function chunk(id: string): CorpusChunk {
	return { id, text: id, sourceId: 's', sourceTitle: 'S', tags: [], url: 'https://example.gov' };
}
function fixtureCorpus(): Corpus {
	return {
		version: '1.0',
		dim: 3,
		modelId: 'all-MiniLM-L6-v2',
		chunks: [chunk('a'), chunk('b')],
		embeddings: [new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0])]
	};
}

describe('createAskStore', () => {
	// The model-downloaded flag persists across sessions; clear it before each test so every case starts
	// "not set up" (mirrors the store's localStorage key). Tests needing a set-up device set it explicitly.
	const MODEL_DOWNLOADED_KEY = 'mtc:ask:model-downloaded';
	beforeEach(() => localStorage.removeItem(MODEL_DOWNLOADED_KEY));

	it('starts idle', () => {
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			corpus: fixtureCorpus()
		});
		expect(store.state.kind).toBe('idle');
	});

	it('shows needsSetup with the query preserved on the first query (no auto-download)', async () => {
		let embedCalls = 0;
		const embed = async () => {
			embedCalls++;
			return new Float32Array([1, 0, 0]);
		};
		const store = createAskStore({ embed, corpus: fixtureCorpus() });
		await store.ask('how do I file a claim');
		expect(store.state.kind).toBe('needsSetup');
		if (store.state.kind === 'needsSetup') {
			expect(store.state.pendingQuery).toBe('how do I file a claim');
		}
		expect(embedCalls).toBe(0); // nothing is downloaded or embedded without consent
	});

	it('setUp() shows modelLoading, answers the preserved query, and persists the flag', async () => {
		let release: (v: Float32Array) => void = () => {};
		const embed = () => new Promise<Float32Array>((r) => (release = r));
		const store = createAskStore({ embed, corpus: fixtureCorpus() });
		await store.ask('q'); // -> needsSetup
		const p = store.setUp();
		expect(store.state.kind).toBe('modelLoading'); // the one-time download is in progress
		release(new Float32Array([1, 0, 0]));
		await p;
		expect(store.state.kind).toBe('results');
		expect(localStorage.getItem(MODEL_DOWNLOADED_KEY)).toBe('1');
	});

	it('dismissSetup() returns to idle', async () => {
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			corpus: fixtureCorpus()
		});
		await store.ask('q'); // -> needsSetup
		store.dismissSetup();
		expect(store.state.kind).toBe('idle');
	});

	it('goes straight to embedding (skips needsSetup) when already set up', async () => {
		localStorage.setItem(MODEL_DOWNLOADED_KEY, '1'); // set up in a prior session
		let release: (v: Float32Array) => void = () => {};
		const embed = () => new Promise<Float32Array>((r) => (release = r));
		const store = createAskStore({ embed, corpus: fixtureCorpus() });
		void store.ask('q'); // sets state synchronously before embed resolves
		expect(store.state.kind).toBe('embedding'); // no needsSetup, no modelLoading
		release(new Float32Array([1, 0, 0]));
	});

	it('surfaces error when an online embed fails (set up)', async () => {
		localStorage.setItem(MODEL_DOWNLOADED_KEY, '1');
		const store = createAskStore({
			embed: async () => {
				throw new AskError(ASK_ERROR.EMBED);
			},
			corpus: fixtureCorpus()
		});
		await store.ask('q');
		expect(store.state.kind).toBe('error');
		if (store.state.kind === 'error') expect(store.state.code).toBe(ASK_ERROR.EMBED);
	});

	it('surfaces offline when the setUp embed fails with no network (first run)', async () => {
		const original = navigator.onLine;
		Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
		try {
			const store = createAskStore({
				embed: async () => {
					throw new AskError(ASK_ERROR.EMBED);
				},
				corpus: fixtureCorpus()
			});
			await store.ask('q'); // -> needsSetup (not set up)
			await store.setUp(); // the first-run embed fails with no network
			expect(store.state.kind).toBe('offline');
		} finally {
			Object.defineProperty(navigator, 'onLine', { value: original, configurable: true });
		}
	});

	it('surfaces error (not offline) when a first-run embed fails while the device is online', async () => {
		// Not set up + ONLINE (the browser-test default): a failed first-run embed is a genuine error, not
		// connectivity. `offline` is reserved for !modelLoaded + no network (the test above).
		const store = createAskStore({
			embed: async () => {
				throw new AskError(ASK_ERROR.EMBED);
			},
			corpus: fixtureCorpus()
		});
		await store.ask('q'); // -> needsSetup (not set up)
		await store.setUp(); // first-run embed fails while online -> error
		expect(store.state.kind).toBe('error');
	});

	it('returns empty when no hit clears the minimum score threshold (set up)', async () => {
		// Query orthogonal to both fixture chunks -> cosine 0 -> below MIN_SCORE, so the threshold gate
		// drops them and `empty` is reachable (spec section 9). Set up so ask() takes the embed path.
		localStorage.setItem(MODEL_DOWNLOADED_KEY, '1');
		const store = createAskStore({
			embed: async () => new Float32Array([0, 0, 1]),
			corpus: fixtureCorpus()
		});
		await store.ask('q');
		expect(store.state.kind).toBe('empty');
	});

	it('ignores a new ask() while a query is already in flight (set up)', async () => {
		// Two overlapping runQuery calls would race on `state` and the later-resolving one would win
		// regardless of submit order; the in-flight guard drops the second submit so the first owns the result.
		localStorage.setItem(MODEL_DOWNLOADED_KEY, '1');
		let calls = 0;
		const store = createAskStore({
			embed: () => {
				calls++;
				return new Promise<Float32Array>(() => {}); // stays pending: the query is in flight
			},
			corpus: fixtureCorpus()
		});
		void store.ask('first'); // -> embedding, embed #1 in flight
		expect(store.state.kind).toBe('embedding');
		void store.ask('second'); // must be ignored while a query is in flight
		expect(calls).toBe(1); // no second embed started
	});
});
