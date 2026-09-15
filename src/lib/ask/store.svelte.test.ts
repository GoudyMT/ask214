import { describe, it, expect, beforeEach } from 'vitest';
import { createAskStore } from './store.svelte';
import { AskError, ASK_ERROR } from './errors';
import type { Corpus, CorpusChunk } from '$lib/corpus';
import type { RetrieveResult } from './online/outcome';
import { detectEligibilityIntent } from './synthesis/eligibility-gate';

function chunk(id: string): CorpusChunk {
	return { id, text: id, sourceId: 's', sourceTitle: 'S', tags: [], url: 'https://example.gov' };
}
function fixtureCorpus(): Corpus {
	return {
		version: '1.0.2',
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
			getCorpus: async () => fixtureCorpus()
		});
		expect(store.state.kind).toBe('idle');
	});

	it('does not load the corpus until a device query runs (lazy)', async () => {
		localStorage.setItem('mtc:ask:model-downloaded', '1'); // set-up device: the query runs, not needsSetup
		let corpusLoads = 0;
		const getCorpus = async () => {
			corpusLoads++;
			return fixtureCorpus();
		};
		const store = createAskStore({ embed: async () => new Float32Array([1, 0, 0]), getCorpus });
		expect(corpusLoads).toBe(0); // construction does not fetch the corpus
		await store.ask('how do I file a claim');
		expect(store.state.kind).toBe('results');
		expect(corpusLoads).toBe(1); // fetched lazily, by the query that needed it
	});

	it('shows needsSetup with the query preserved on the first query (no auto-download)', async () => {
		let embedCalls = 0;
		const embed = async () => {
			embedCalls++;
			return new Float32Array([1, 0, 0]);
		};
		const store = createAskStore({ embed, getCorpus: async () => fixtureCorpus() });
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
		const store = createAskStore({ embed, getCorpus: async () => fixtureCorpus() });
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
			getCorpus: async () => fixtureCorpus()
		});
		await store.ask('q'); // -> needsSetup
		store.dismissSetup();
		expect(store.state.kind).toBe('idle');
	});

	it('goes straight to embedding (skips needsSetup) when already set up', async () => {
		localStorage.setItem(MODEL_DOWNLOADED_KEY, '1'); // set up in a prior session
		let release: (v: Float32Array) => void = () => {};
		const embed = () => new Promise<Float32Array>((r) => (release = r));
		const store = createAskStore({ embed, getCorpus: async () => fixtureCorpus() });
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
			getCorpus: async () => fixtureCorpus()
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
				getCorpus: async () => fixtureCorpus()
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
			getCorpus: async () => fixtureCorpus()
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
			getCorpus: async () => fixtureCorpus()
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
			getCorpus: async () => fixtureCorpus()
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
			getCorpus: async () => fixtureCorpus()
		});
		await store.ask('I want to kill myself');
		expect(store.state.kind).toBe('crisis');
		expect(embedCalls).toBe(0); // never retrieves or synthesizes a crisis message
	});

	it('routes a crisis message to crisis even when not set up (skips the download gate)', async () => {
		// A normal first query goes to needsSetup; a crisis message must skip that and route straight to help.
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			getCorpus: async () => fixtureCorpus()
		});
		await store.ask("I don't want to be here anymore after I get out");
		expect(store.state.kind).toBe('crisis');
	});

	// --- online seam (additive; absent deps => device-identical, so the 13 tests above are untouched) ---

	type StoreDeps = Parameters<typeof createAskStore>[0];

	function onlineStore(over: Partial<StoreDeps> = {}) {
		// Default: an already-consented device. Most tests below exercise the POST-consent online path; the
		// consent gate itself is tested with an explicit onlineConsented:()=>false.
		let consented = true;
		const base: StoreDeps = {
			embed: async () => new Float32Array([1, 0, 0]),
			getCorpus: async () => fixtureCorpus(),
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

	it('online mode answers without ever loading the corpus', async () => {
		let corpusLoads = 0;
		const store = onlineStore({
			getCorpus: async () => {
				corpusLoads++;
				return fixtureCorpus();
			}
		});
		await store.ask('how do I file a claim'); // online is the default + already consented here
		expect(store.state.kind).toBe('results');
		expect(corpusLoads).toBe(0); // online retrieval is server-side; the corpus stays unfetched
	});

	it('an online answer records origin online (so the privacy copy cannot mislabel it)', async () => {
		const store = onlineStore();
		await store.ask('how do I file a claim'); // online default + already consented
		expect(store.state.kind).toBe('results');
		if (store.state.kind === 'results') expect(store.state.origin).toBe('online');
	});

	it('a device answer records origin device', async () => {
		localStorage.setItem('mtc:ask:model-downloaded', '1'); // set-up device: the query runs
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			getCorpus: async () => fixtureCorpus()
		});
		await store.ask('how do I file a claim');
		expect(store.state.kind).toBe('results');
		if (store.state.kind === 'results') expect(store.state.origin).toBe('device');
	});

	it('defaults to device mode and shows no nudge when no online deps are given', () => {
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			getCorpus: async () => fixtureCorpus()
		});
		expect(store.mode).toBe('device');
		expect(store.showNudge).toBe(false);
	});

	it('the consent gate holds a first online ask, then consentOnline records consent and answers it', async () => {
		let consented = false;
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			getCorpus: async () => fixtureCorpus(),
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
		expect(store.state.kind).toBe('needsReconsent'); // held at the gate, not sent
		expect(consented).toBe(false); // merely asking records no consent
		await store.consentOnline(); // the user confirms
		expect(consented).toBe(true); // consent is recorded at the gate
		expect(store.state.kind).toBe('results'); // and the held query is answered
		if (store.state.kind === 'results') expect(store.state.cards).toHaveLength(1);
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
		if (store.state.kind === 'results') expect(store.state.answer?.kind).toBe('synthesized');
	});

	// A crisis turn routes to help and NOTHING else. The keyword pre-gate already commits `crisis` with no
	// cards; when the model catches an indirect phrasing the net missed, it has to land in the same place.
	// Committing it as a summary would have rendered the crisis surface on top of a list of benefits
	// cards - the wrong answer to the question actually being asked.
	it('commits a crisis synthesis result as the crisis state, dropping the cards', async () => {
		const store = onlineStore({
			synthesisEnabled: () => true,
			synthesize: async () => ({ kind: 'crisis' })
		});
		await store.ask('i dont see a way forward anymore');
		expect(store.state.kind).toBe('crisis');
	});

	// Was "omits the summary ... (raw cards only)". Disabling synthesis still means no MODEL summary - that
	// part is unchanged and is what this asserts. What changed is the fallback: the slot now holds the
	// document's own sentences instead of nothing, so the user gets an answer either way.
	it('shows no model summary when synthesis is disabled, but still answers', async () => {
		const store = onlineStore({
			synthesisEnabled: () => false,
			synthesize: async () => ({ kind: 'degraded' })
		});
		await store.ask('q');
		if (store.state.kind === 'results') expect(store.state.answer?.kind).toBe('extractive');
	});

	it('a user switch to online egresses nothing; the first ask then hits the consent gate', async () => {
		let sent = 0;
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			getCorpus: async () => fixtureCorpus(),
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
		await store.ask('q'); // the first online ask hits the consent gate - still no egress
		expect(store.state.kind).toBe('needsReconsent');
		expect(sent).toBe(0);
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
			getCorpus: async () => fixtureCorpus()
		});
		const p = store.ask('benign'); // -> embedding, suspended on embed
		expect(store.state.kind).toBe('embedding');
		await store.ask('I want to kill myself');
		expect(store.state.kind).toBe('crisis');
		release(new Float32Array([1, 0, 0]));
		await p;
		expect(store.state.kind).toBe('crisis');
	});

	// The original guarantee - a throwing synthesize must never strand the spinner - is unchanged. The
	// fallback it lands on is now an answer rather than bare cards.
	it('a throwing synthesize falls back to the extractive answer instead of stranding the UI', async () => {
		const store = onlineStore({
			synthesisEnabled: () => true,
			synthesize: async () => {
				throw new Error('boom');
			}
		});
		await store.ask('q');
		expect(store.state.kind).toBe('results');
		if (store.state.kind !== 'results') return;
		expect(store.state.answer?.kind).toBe('extractive');
		if (store.state.answer?.kind !== 'extractive') return;
		// A thrown call is NOT "synthesis never ran", and the answer block discloses on that difference.
		// Swallowing it to `undefined` made a failure indistinguishable from a reader who never enabled it.
		expect(store.state.answer.synthesisNote).toBe('unavailable');
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
		const store = onlineStore(); // online-capable; consent state irrelevant (no ask() here)
		store.setMode('device');
		expect(store.mode).toBe('device');
		expect(store.state.kind).toBe('idle');
		store.setMode('online'); // flips up cleanly - no blocking gate
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

	it('once consented, later online asks egress directly with no gate', async () => {
		const store = onlineStore(); // helper default: an already-consented device
		await store.ask('q');
		expect(store.state.kind).toBe('results'); // consented -> straight through, no gate
		await store.ask('another');
		expect(store.state.kind).toBe('results'); // and it stays gate-free on subsequent asks
	});

	// --- H1: first-egress consent gate (the first online query on a never-consented device is held) ---

	it('holds the first online query behind the consent gate instead of egressing', async () => {
		let sent = 0;
		const store = onlineStore({
			onlineConsented: () => false, // never consented on this device
			retrieveOnline: async () => {
				sent++;
				return { status: 'empty', corpusVersion: '1.0' };
			}
		});
		await store.ask('how do I transfer my GI Bill');
		expect(store.state.kind).toBe('needsReconsent');
		if (store.state.kind === 'needsReconsent') {
			expect(store.state.pendingQuery).toBe('how do I transfer my GI Bill');
		}
		expect(sent).toBe(0); // nothing egressed before consent
	});

	it('crisis still short-circuits above the consent gate (never egresses, never gates)', async () => {
		const store = onlineStore({ onlineConsented: () => false }); // online, never consented
		await store.ask('I want to kill myself');
		expect(store.state.kind).toBe('crisis'); // crisis wins over the gate
	});

	it('declining the gate ("stay on device") keeps the question and routes it to the device path', async () => {
		const store = onlineStore({ onlineConsented: () => false });
		await store.ask('how do I file a claim'); // -> needsReconsent (held)
		expect(store.state.kind).toBe('needsReconsent');
		await store.stayOnDevice(); // decline: switch to device, answer there
		expect(store.mode).toBe('device');
		expect(store.state.kind).toBe('needsSetup'); // the device path preserves + gates its own setup
		if (store.state.kind === 'needsSetup')
			expect(store.state.pendingQuery).toBe('how do I file a claim');
	});

	it('the gate fails closed when the consent dep is absent (holds, never egresses)', async () => {
		// Defense-in-depth: an online-capable store built without an `onlineConsented` dep must HOLD the
		// first query, not egress it - matching the store's own absent-dep-is-safe convention.
		let sent = 0;
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			getCorpus: async () => fixtureCorpus(),
			retrieveOnline: async () => {
				sent++;
				return { status: 'empty', corpusVersion: '1.0' };
			}
			// no onlineConsented / markOnlineConsent injected
		});
		await store.ask('q');
		expect(store.state.kind).toBe('needsReconsent'); // fail-closed: held, not sent
		expect(sent).toBe(0);
	});

	it('a fresh submit while the gate is open re-arms it with the new query (no stale send)', async () => {
		const store = onlineStore({ onlineConsented: () => false });
		await store.ask('first question'); // -> needsReconsent, holds "first question"
		expect(store.state.kind).toBe('needsReconsent');
		await store.ask('second question'); // re-submit at the open gate
		expect(store.state.kind).toBe('needsReconsent');
		if (store.state.kind === 'needsReconsent') {
			expect(store.state.pendingQuery).toBe('second question'); // the gate tracks the latest query
		}
	});

	it('a crisis message submitted at the open consent gate still routes to crisis (guard ordering)', async () => {
		let sent = 0;
		const store = onlineStore({
			onlineConsented: () => false,
			retrieveOnline: async () => {
				sent++;
				return { status: 'empty', corpusVersion: '1.0' };
			}
		});
		await store.ask('what benefits am I owed'); // -> needsReconsent (gate open)
		expect(store.state.kind).toBe('needsReconsent');
		await store.ask('I want to kill myself'); // crisis at the open gate
		expect(store.state.kind).toBe('crisis'); // crisis wins over the gate guard
		expect(sent).toBe(0); // and nothing egressed
	});

	// The answer slot. Until now it was filled only when the user supplied an API key, was online, and had
	// the toggle on - so the default and offline user never saw an answer at all, only ranked excerpts.
	describe('the answer slot', () => {
		// Real prose, because the whole feature is choosing WHICH sentences to show; the 'a'/'b' fixtures
		// above cannot exercise selection. The id carries the shipped `<sourceId>:<12 hex>` shape for the
		// same reason a colon-free slug hid a defect on the synthesis path for an entire release.
		const INTENT_TEXT =
			'Your Intent to File Once you notify us of your intent to file you have one year to submit ' +
			'the completed claim. The date we receive it becomes your effective date for benefits.';

		function intentCorpus(): Corpus {
			return {
				version: '1.0.2',
				dim: 3,
				modelId: 'all-MiniLM-L6-v2',
				chunks: [
					{
						id: 'va_intent_to_file:9f2c1a7b4e60',
						text: INTENT_TEXT,
						section: 'Your Intent to File',
						sourceId: 'va_intent_to_file',
						sourceTitle: 'VA - Intent to File',
						tags: [],
						url: 'https://www.va.gov/'
					}
				],
				embeddings: [new Float32Array([1, 0, 0])]
			};
		}

		function deviceStore() {
			localStorage.setItem(MODEL_DOWNLOADED_KEY, '1'); // set up, so the query runs rather than gating
			return createAskStore({
				embed: async () => new Float32Array([1, 0, 0]),
				getCorpus: async () => intentCorpus()
			});
		}

		// Deliberately impersonal, so the 38 CFR gate does not fire and this isolates the plain answer path.
		it('answers on the device path, with no key and no network', async () => {
			const store = deviceStore();
			await store.ask('what is the deadline for submitting a completed claim?');
			expect(store.state.kind).toBe('results');
			if (store.state.kind !== 'results') return;
			expect(store.state.answer?.kind).toBe('extractive');
			if (store.state.answer?.kind !== 'extractive') return;
			// The document's own sentence, with the duplicated heading gone.
			expect(store.state.answer.answer.text).toContain('one year to submit');
			expect(store.state.answer.answer.text.startsWith('Your Intent to File')).toBe(false);
		});

		// The input box stays editable after results render, so reading the query at render time would let
		// the displayed answer drift away from the question it actually answered. `origin` is snapshot for
		// exactly this reason already.
		// 38 CFR 14.629. The gate lived inside synthesize(), so it needed online AND a key AND the toggle -
		// the device user was never gated at all. Phrasing taken from the shipped red-team fixture.
		it('attaches the eligibility note on the device path, where no gate ran before', async () => {
			const store = deviceStore();
			const query = 'I have a 30% rating and served 8 years, what am I entitled to?';
			// The PREMISE, asserted rather than assumed: this test is about what happens when the gate
			// fires, so if the gate ever stopped firing on this phrasing it would keep passing while
			// testing nothing it claims to test.
			expect(detectEligibilityIntent(query).shortCircuit).toBe(true);
			await store.ask(query);
			expect(store.state.kind).toBe('results');
			if (store.state.kind !== 'results') return;
			// The 38 CFR note is PERMANENT on the extractive block (AskAnswer.svelte), because the gate reads
			// the question's phrasing and misses cases like "can I use VA health care". What this asserts is
			// the other half of the gate: the answer still renders rather than being replaced by a redirect.
			expect(store.state.answer?.kind).toBe('extractive');
		});

		it('still shows the source cards under the eligibility note', async () => {
			const store = deviceStore();
			const query = 'I have a 30% rating and served 8 years, what am I entitled to?';
			expect(detectEligibilityIntent(query).shortCircuit).toBe(true);
			await store.ask(query);
			expect(store.state.kind).toBe('results');
			if (store.state.kind !== 'results') return;
			expect(store.state.cards.length).toBeGreaterThan(0);
		});

		// The gate's possessive-benefit signal fires on plain procedural questions - 28.9% of the
		// benchmark. Those must still get the answer the document plainly contains, with the note attached.
		it('still answers a procedural question that trips the gate', async () => {
			const store = deviceStore();
			const query = 'how long do I have to submit my claim?';
			// The premise again: the whole point is that a PROCEDURAL question trips the gate. Without this
			// the test would survive the gate going quiet on exactly the cases it was written to cover.
			expect(detectEligibilityIntent(query).shortCircuit).toBe(true);
			await store.ask(query);
			expect(store.state.kind).toBe('results');
			if (store.state.kind !== 'results') return;
			expect(store.state.answer?.kind).toBe('extractive');
			if (store.state.answer?.kind !== 'extractive') return;
			expect(store.state.answer.answer.text).toContain('one year to submit');
		});
	});
});
