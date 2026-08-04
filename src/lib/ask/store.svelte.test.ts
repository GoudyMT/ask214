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
		// drops them and `empty` is reachable. Set up so ask() takes the embed path.
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

	it('short-circuits a crisis message to the crisis state without ever embedding (set up)', async () => {
		localStorage.setItem(MODEL_DOWNLOADED_KEY, '1'); // even a set-up device must not search a crisis message
		let embedCalls = 0;
		const store = createAskStore({
			embed: async () => {
				embedCalls++;
				return new Float32Array([1, 0, 0]);
			},
			corpus: fixtureCorpus()
		});
		await store.ask('I want to kill myself');
		expect(store.state.kind).toBe('crisis');
		expect(embedCalls).toBe(0); // never retrieves or synthesizes a crisis message
	});

	it('routes a crisis message to crisis even when not set up (skips the download gate)', async () => {
		// A normal first query goes to needsSetup; a crisis message must skip that and route straight to help.
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			corpus: fixtureCorpus()
		});
		await store.ask("I don't want to be here anymore after I get out");
		expect(store.state.kind).toBe('crisis');
	});

	// --- online seam (additive; absent deps => device-identical, so the 13 tests above are untouched) ---

	type StoreDeps = Parameters<typeof createAskStore>[0];

	function onlineStore(over: Partial<StoreDeps> = {}) {
		let consented = false;
		const base: StoreDeps = {
			embed: async () => new Float32Array([1, 0, 0]),
			corpus: fixtureCorpus(),
			retrieveOnline: async () => ({
				status: 'results',
				corpusVersion: '1.0',
				results: [
					{
						score: 0.9,
						chunk: {
							id: 'a',
							text: 'A',
							sourceId: 's',
							sourceTitle: 'S',
							url: 'https://x.gov',
							tags: []
						}
					}
				]
			}),
			onlineConsented: () => consented,
			markOnlineConsent: () => (consented = true)
		};
		return createAskStore({ ...base, ...over });
	}

	it('defaults to device mode and shows no nudge when no online deps are given', () => {
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			corpus: fixtureCorpus()
		});
		expect(store.mode).toBe('device');
		expect(store.showNudge).toBe(false);
	});

	it('answers an online query with cards and marks consent on the first disclosed egress', async () => {
		let consented = false;
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			corpus: fixtureCorpus(),
			retrieveOnline: async () => ({
				status: 'results',
				corpusVersion: '1.0',
				results: [
					{
						score: 0.9,
						chunk: {
							id: 'a',
							text: 'A',
							sourceId: 's',
							sourceTitle: 'S',
							url: 'https://x.gov',
							tags: []
						}
					}
				]
			}),
			onlineConsented: () => consented,
			markOnlineConsent: () => (consented = true)
		});
		await store.ask('how do I transfer GI Bill');
		expect(store.state.kind).toBe('results');
		if (store.state.kind === 'results') expect(store.state.cards).toHaveLength(1);
		expect(consented).toBe(true); // the disclosed default egress records consent
	});

	it('maps an online empty to empty (a real "no source", not a fault)', async () => {
		const store = onlineStore({
			retrieveOnline: async () => ({ status: 'empty', corpusVersion: '1.0' })
		});
		await store.ask('obscure');
		expect(store.state.kind).toBe('empty');
	});

	it('degrades a transport error to the offer-device rung (device is the fallback)', async () => {
		const store = onlineStore({ retrieveOnline: async () => ({ status: 'error' }) });
		await store.ask('q');
		expect(store.state.kind).toBe('degraded');
		if (store.state.kind === 'degraded') expect(store.state.rung).toBe('offer_device');
	});

	it('degrades a high_demand response onto the ladder', async () => {
		const store = onlineStore({ retrieveOnline: async () => ({ status: 'high_demand' }) });
		await store.ask('q');
		expect(store.state.kind).toBe('degraded');
	});

	it('renders an AI summary above the cards when synthesis is enabled', async () => {
		const store = onlineStore({
			synthesisEnabled: () => true,
			synthesize: async () => ({
				kind: 'answer',
				answer: {
					text: 'A [a].',
					citations: [{ id: 'a', url: 'https://x.gov', title: 'S' }],
					inert: [],
					disclaimer: 'd'
				}
			})
		});
		await store.ask('q');
		expect(store.state.kind).toBe('results');
		if (store.state.kind === 'results') expect(store.state.summary?.kind).toBe('answer');
	});

	it('omits the summary when synthesis is disabled (raw cards only)', async () => {
		const store = onlineStore({
			synthesisEnabled: () => false,
			synthesize: async () => ({ kind: 'degraded' })
		});
		await store.ask('q');
		if (store.state.kind === 'results') expect(store.state.summary).toBeUndefined();
	});

	it('blocks a device->online switch behind reconsent and sends nothing until confirmed', async () => {
		let sent = 0;
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			corpus: fixtureCorpus(),
			retrieveOnline: async () => {
				sent++;
				return { status: 'results', corpusVersion: '1.0', results: [] };
			},
			onlineConsented: () => false, // never consented on this device
			markOnlineConsent: () => {}
		});
		store.setMode('device'); // start on device explicitly
		store.setMode('online'); // switch back up -> must reconsent (not consented)
		expect(store.state.kind).toBe('needsReconsent');
		await store.ask('q'); // an ask while reconsent is pending must NOT egress
		expect(sent).toBe(0);
		store.consentOnline(); // now confirm
		expect(store.mode).toBe('online');
		await store.ask('q');
		expect(sent).toBe(1);
	});

	it('shows the private-mode nudge after the threshold and hides it on dismiss', async () => {
		const store = onlineStore({ nudgeAfter: 2 });
		await store.ask('one');
		expect(store.showNudge).toBe(false); // 1 query, below threshold
		await store.ask('two');
		expect(store.showNudge).toBe(true); // threshold reached, device not set up
		store.dismissNudge();
		expect(store.showNudge).toBe(false);
	});
});
