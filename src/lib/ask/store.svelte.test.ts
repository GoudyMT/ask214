import { describe, it, expect, beforeEach } from 'vitest';
import { createAskStore } from './store.svelte';
import { AskError, ASK_ERROR } from './errors';
import type { Corpus, CorpusChunk } from '$lib/corpus';
import type { RetrieveResult } from './online/outcome';

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

	it('a user switch to online flips the mode and egresses nothing until the disclosed ask', async () => {
		let sent = 0;
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			corpus: fixtureCorpus(),
			retrieveOnline: async () => {
				sent++;
				return {
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
				};
			},
			onlineConsented: () => false, // never consented on this device
			markOnlineConsent: () => {}
		});
		store.setMode('device'); // start on device explicitly
		store.setMode('online'); // a user-initiated switch: flips instantly, no blocking modal
		expect(store.mode).toBe('online');
		expect(store.state.kind).toBe('idle'); // the feed persists; the switch itself sends nothing
		expect(sent).toBe(0);
		await store.ask('q'); // the disclosed ask is the only egress
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

	// --- run terminal-write robustness: a stale run must never clobber a superseding state ---

	const oneHit: RetrieveResult = {
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
	};

	it('a crisis submitted during an in-flight online query keeps the crisis state (no clobber)', async () => {
		let release: (r: RetrieveResult) => void = () => {};
		const store = onlineStore({
			retrieveOnline: () => new Promise<RetrieveResult>((r) => (release = r))
		});
		const p = store.ask('what benefits am I owed'); // -> embedding, suspended on retrieveOnline
		expect(store.state.kind).toBe('embedding');
		await store.ask('I want to kill myself'); // crisis short-circuits (above the in-flight guard)
		expect(store.state.kind).toBe('crisis');
		release(oneHit);
		await p;
		expect(store.state.kind).toBe('crisis'); // the stale result did NOT tear the crisis card down
	});

	it('a crisis submitted during an in-flight device query keeps the crisis state', async () => {
		localStorage.setItem('mtc:ask:model-downloaded', '1'); // set up -> the device path embeds
		let release: (v: Float32Array) => void = () => {};
		const store = createAskStore({
			embed: () => new Promise<Float32Array>((r) => (release = r)),
			corpus: fixtureCorpus()
		});
		const p = store.ask('benign'); // -> embedding, suspended on embed
		expect(store.state.kind).toBe('embedding');
		await store.ask('I want to kill myself');
		expect(store.state.kind).toBe('crisis');
		release(new Float32Array([1, 0, 0]));
		await p;
		expect(store.state.kind).toBe('crisis');
	});

	it('a throwing synthesize falls back to raw cards instead of stranding the UI', async () => {
		const store = onlineStore({
			synthesisEnabled: () => true,
			synthesize: async () => {
				throw new Error('boom');
			}
		});
		await store.ask('q');
		expect(store.state.kind).toBe('results');
		if (store.state.kind === 'results') expect(store.state.summary).toBeUndefined();
	});

	it('a results body with no valid hits degrades (a fault is not an authoritative "no source")', async () => {
		const store = onlineStore({
			retrieveOnline: async () => ({ status: 'results', corpusVersion: '1.0', results: [] })
		});
		await store.ask('q');
		expect(store.state.kind).toBe('degraded');
	});

	it('an online query that fails while offline shows the offline hint, not a dead-end degrade', async () => {
		const original = navigator.onLine;
		Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
		try {
			const store = onlineStore({
				retrieveOnline: async () => {
					throw new Error('net');
				}
			});
			await store.ask('q');
			expect(store.state.kind).toBe('offline');
		} finally {
			Object.defineProperty(navigator, 'onLine', { value: original, configurable: true });
		}
	});

	it('toggling online<->device is a pure flip that keeps the feed and never traps the user', () => {
		const store = onlineStore(); // online-capable, not consented by default
		store.setMode('device');
		expect(store.mode).toBe('device');
		expect(store.state.kind).toBe('idle');
		store.setMode('online'); // flips up cleanly - no blocking modal
		expect(store.mode).toBe('online');
		expect(store.state.kind).toBe('idle'); // the feed persists throughout
		store.setMode('device'); // and back down
		expect(store.mode).toBe('device');
		expect(store.state.kind).toBe('idle');
	});

	it('consentOnline() records consent and switches to online (the reserved re-consent completer)', () => {
		let consented = false;
		const store = onlineStore({ markOnlineConsent: () => (consented = true) });
		store.setMode('device'); // go device so the switch to online is observable
		store.consentOnline();
		expect(store.mode).toBe('online');
		expect(consented).toBe(true); // consent is recorded, not just the mode flipped
	});

	it('a device retrieval failure offers the online path (the ladder device->online direction)', async () => {
		localStorage.setItem('mtc:ask:model-downloaded', '1'); // set up -> device embeds (not the offline first-run)
		const store = onlineStore({
			embed: async () => {
				throw new AskError(ASK_ERROR.EMBED);
			}
		});
		store.setMode('device');
		await store.ask('q');
		expect(store.state.kind).toBe('degraded');
		if (store.state.kind === 'degraded') expect(store.state.rung).toBe('offer_online');
	});

	it('once both online and device have failed, the ladder is terminal (outbound hub)', async () => {
		localStorage.setItem('mtc:ask:model-downloaded', '1');
		const store = onlineStore({
			retrieveOnline: async () => ({ status: 'error' }),
			embed: async () => {
				throw new AskError(ASK_ERROR.EMBED);
			}
		});
		await store.ask('q'); // online (default) fails -> offer_device
		expect(store.state.kind).toBe('degraded');
		if (store.state.kind === 'degraded') expect(store.state.rung).toBe('offer_device');
		store.setMode('device'); // take the device offer
		await store.ask('q'); // device also fails -> both failed -> outbound hub
		expect(store.state.kind).toBe('degraded');
		if (store.state.kind === 'degraded') expect(store.state.rung).toBe('outbound_hub');
	});

	// A device choice lost to storage eviction is indistinguishable from a new user, so it inherits the
	// online-default + inline disclosure (a blocking re-consent would need a durable signal ITP wipes too).
	it('the default online mode egresses inline-disclosed, without a blocking modal', async () => {
		const store = onlineStore(); // no consent, no pref -> online-default (a new OR post-eviction device)
		expect(store.mode).toBe('online');
		expect(store.state.kind).not.toBe('needsReconsent'); // no blocking modal on the default path
		await store.ask('q');
		expect(store.state.kind).toBe('results'); // it egressed; the inline privacy line discloses it
	});
});
