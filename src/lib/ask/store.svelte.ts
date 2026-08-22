import { search, toResultCards, type Corpus } from '$lib/corpus';
import { filterByMinScore } from './threshold';
import { detectCrisisIntent } from './crisis/detect';
import { AskError, ASK_ERROR } from './errors';
import type { AskState } from './types';
import type { RetrieveResult } from './online/outcome';
import { nextRung, type Rung } from './online/ladder';
import { narrowScored, toRetrievedChunks } from './online/scored';
import type { RetrievedChunk, SynthesisResult } from './synthesis/synthesize';
import { toSynthesisView, type SynthesisView } from './synthesis/synthesis-view';
import { SvelteSet } from 'svelte/reactivity';

const K = 5; // result cards per query (3-5)
// Minimum cosine score a hit must clear to surface: weak matches are dropped rather
// than padded in, which is also what makes `empty` reachable. Calibrated against the eval set - set
// below the weakest relevant lead so a valid answer is never dropped, and above the off-topic noise
// tail so unrelated hits collapse. Recalibrate as the corpus scales.
const MIN_SCORE = 0.4;

// The ~23MB on-device search model is fetched + cached once, then served from cache forever.
// We persist one non-PII boolean - "was the model downloaded on this device?" - so the "downloading..."
// modelLoading message shows on the first-EVER query only, not once per session. This
// is a device-capability flag, NOT user data (no query, no profile, nothing personal), so plain
// localStorage is correct here - the encrypted-IDB rule governs PII, which this is not.
const MODEL_DOWNLOADED_KEY = 'mtc:ask:model-downloaded';

function readModelDownloaded(): boolean {
	return typeof localStorage !== 'undefined' && localStorage.getItem(MODEL_DOWNLOADED_KEY) === '1';
}

function markModelDownloaded(): void {
	if (typeof localStorage !== 'undefined') localStorage.setItem(MODEL_DOWNLOADED_KEY, '1');
}

/**
 * The Ask view store: holds the `AskState` machine and orchestrates one query. `embed` + `getCorpus` are
 * injected so the device path is unit-testable without a model/worker; `getCorpus` is lazy so the corpus
 * is fetched on the first device query, never at construction (keeping it off the initial page load).
 *
 * ADDITIVE online seam: when `retrieveOnline` is absent the store is device-only and behaves exactly as
 * before (soft opt-in on-device retrieval). When present, it defaults to online but holds the FIRST egress
 * behind an explicit consent gate (remembered per device), degrades onto the ladder, and (when synthesis is
 * enabled) attaches an AI-summary view above the cards. The online closures are route-bound so `fetch`, the
 * corpus version, and the raw BYO key never live in the store.
 *
 * Soft opt-in (device path, unchanged): the ~23MB model is NEVER auto-downloaded. The first query on an
 * un-set-up device goes to `needsSetup` with the query preserved; the download happens only when the user
 * consents via `setUp()`. A set-up device (persisted flag) skips straight to `embedding`.
 */
export function createAskStore(deps: {
	embed: (text: string) => Promise<Float32Array>;
	getCorpus: () => Promise<Corpus>;
	retrieveOnline?: (query: string) => Promise<RetrieveResult>;
	synthesize?: (query: string, chunks: RetrievedChunk[]) => Promise<SynthesisResult>;
	onlineConsented?: () => boolean;
	markOnlineConsent?: () => void;
	synthesisEnabled?: () => boolean;
	nudgeAfter?: number;
}) {
	let state = $state<AskState>({ kind: 'idle' });
	let modelLoaded = $state(readModelDownloaded()); // $state so `showNudge` stays reactive to it

	// Online is available only when the route supplied the retrieve closure; that presence (not a global
	// default) is what keeps the change additive - a device-only construction is identical to before.
	const onlineCapable = deps.retrieveOnline !== undefined;
	let mode = $state<'device' | 'online'>(onlineCapable ? 'online' : 'device');
	let askedCount = $state(0);
	let nudgeDismissed = $state(false);
	const nudgeAfter = deps.nudgeAfter ?? 2;
	// Which paths have failed this session, so the degradation ladder never re-offers a dead one.
	const failed = new SvelteSet<'online' | 'device'>();

	// The embed -> search -> cards path. The loading state is `modelLoading` on the first run (that embed
	// triggers the one-time ~23MB download) and `embedding` once set up. Shared by ask() (warm) + setUp().
	async function runQuery(query: string): Promise<void> {
		state = modelLoaded ? { kind: 'embedding' } : { kind: 'modelLoading' };
		try {
			// Load the model (embed) and the corpus in parallel. The corpus is fetched lazily here - only a
			// device query needs it - so it stays off the initial page load, where a 3.5MB eager fetch would
			// otherwise pin LCP/TTI to its download time.
			const [vector, corpus] = await Promise.all([deps.embed(query), deps.getCorpus()]);
			modelLoaded = true;
			markModelDownloaded();
			const cards = toResultCards(filterByMinScore(search(vector, corpus, K), MIN_SCORE));
			commitIfCurrent(cards.length > 0 ? { kind: 'results', cards } : { kind: 'empty' });
		} catch (e) {
			const code = e instanceof AskError ? e.code : ASK_ERROR.EMBED;
			// Superseded mid-embed (a crisis message routed to help, a pending consent gate) - do not clobber.
			if (state.kind !== 'embedding' && state.kind !== 'modelLoading') return;
			// Offline only when a first-run (model-not-loaded) embed fails with no network: a warm embed
			// needs no network, so its failure is a genuine error, not connectivity.
			const online = typeof navigator === 'undefined' || navigator.onLine;
			if (!modelLoaded && !online) {
				state = { kind: 'offline' };
			} else if (onlineCapable) {
				// A device retrieval failure offers the working online path (or the outbound hub once both
				// paths have failed this session) - the ladder's device->online direction.
				state = { kind: 'degraded', rung: rungAfter('device'), query };
			} else {
				state = { kind: 'error', code };
			}
		}
	}

	// The degradation rung after a path fails this session. Device is capable when the model is already set
	// up OR the device is online (so it could download it); an offline, un-set-up device has no in-app
	// fallback, so nextRung returns the terminal outbound_hub. Once both are marked failed, so is it.
	function rungAfter(which: 'online' | 'device'): Rung {
		failed.add(which);
		const deviceCapable = modelLoaded || typeof navigator === 'undefined' || navigator.onLine;
		return nextRung({ failed, deviceCapable });
	}

	// A run's terminal write must not clobber a state that superseded it mid-flight - a crisis message
	// (routed straight to help), a pending consent gate, or a mode change. Only commit if we are still in
	// the working state this run set; otherwise the superseding transition stands.
	function commitIfCurrent(next: AskState): void {
		if (state.kind === 'embedding' || state.kind === 'modelLoading') state = next;
	}

	// Degrade an online failure onto the ladder, guarding the same supersession + the `failed` mutation.
	// Offline is a dead end for the ladder (even its outbound hub is unreachable), so surface the offline hint.
	function degradeOnline(query: string): void {
		if (state.kind !== 'embedding' && state.kind !== 'modelLoading') return;
		if (!(typeof navigator === 'undefined' || navigator.onLine)) {
			state = { kind: 'offline' };
			return;
		}
		state = { kind: 'degraded', rung: rungAfter('online'), query };
	}

	// The online path: consent + crisis were already settled before we get here (the gate in ask() holds the
	// first egress until consentOnline records it). Every transport fault and high-demand response degrades
	// onto the ladder; only a genuine below-threshold server result is `empty`. The BYO key is never read
	// here - synthesize is a route closure that reads it on demand.
	async function runOnline(query: string): Promise<void> {
		state = { kind: 'embedding' };
		askedCount++;
		let result: RetrieveResult;
		try {
			result = await deps.retrieveOnline!(query);
		} catch {
			degradeOnline(query);
			return;
		}
		if (result.status === 'empty') {
			commitIfCurrent({ kind: 'empty' });
			return;
		}
		if (result.status !== 'results') {
			degradeOnline(query);
			return;
		}
		const hits = narrowScored(result.results);
		const cards = toResultCards(hits);
		// A `results` body that narrows to nothing is a server/protocol fault, not an authoritative
		// "no official source covers that" - degrade rather than mislead.
		if (cards.length === 0) {
			degradeOnline(query);
			return;
		}
		let summary: SynthesisView | undefined;
		if (deps.synthesize && deps.synthesisEnabled?.()) {
			try {
				summary = toSynthesisView(await deps.synthesize(query, toRetrievedChunks(hits)));
			} catch {
				// A throwing synthesize must never strand the spinner; fall back to the raw cards.
				summary = undefined;
			}
		}
		commitIfCurrent(summary ? { kind: 'results', cards, summary } : { kind: 'results', cards });
	}

	async function ask(query: string): Promise<void> {
		const trimmed = query.trim();
		if (trimmed === '') return; // ignore empty submits
		// A crisis / self-harm message short-circuits everything - it is never embedded, retrieved, or
		// gated on setup; the view routes straight to crisis-line help. The message is never stored or sent.
		if (detectCrisisIntent(trimmed).crisis) {
			state = { kind: 'crisis' };
			return;
		}
		// While the consent gate is open, a fresh submit re-arms it with the new query (mirrors the shipped
		// device-setup gate) so consenting sends what the box shows, never a stale held query. Egress stays
		// blocked: re-arming sends nothing, and the crisis check above still wins.
		if (state.kind === 'needsReconsent') {
			state = { kind: 'needsReconsent', pendingQuery: trimmed };
			return;
		}
		// Ignore a new submit while a query is already running: overlapping runs race on `state`
		// and the later-resolving one would win regardless of submit order.
		if (state.kind === 'modelLoading' || state.kind === 'embedding') return;
		if (mode === 'online' && onlineCapable) {
			// First-egress consent: the first online query on a device that has never consented is held behind
			// an explicit gate - the disclosed default is not licence to send words off-device unasked. Consent
			// is remembered per device, so this fires once. Crisis was already ruled out above. Fail CLOSED when
			// the consent dep is absent (`?? false`), matching the store's absent-dep-is-safe convention.
			if (!(deps.onlineConsented?.() ?? false)) {
				state = { kind: 'needsReconsent', pendingQuery: trimmed };
				return;
			}
			await runOnline(trimmed);
			return;
		}
		// Un-set-up device: consent-gate the one-time download (never auto-fetch). Preserve the query so
		// setUp() can answer it; a set-up device runs it straight away.
		if (!modelLoaded) {
			state = { kind: 'needsSetup', pendingQuery: trimmed };
			return;
		}
		await runQuery(trimmed);
	}

	// Consent action: run the one-time download (shown as `modelLoading`) then answer the preserved query.
	async function setUp(): Promise<void> {
		if (state.kind !== 'needsSetup') return;
		await runQuery(state.pendingQuery);
	}

	// [Not now]: drop the pending query and return to idle.
	function dismissSetup(): void {
		if (state.kind === 'needsSetup') state = { kind: 'idle' };
	}

	// A user-initiated mode switch is a pure preference: it flips instantly and egresses nothing. Switching
	// to online never egresses by itself - the first actual ask is what the consent gate holds. Choosing
	// device clears a pending gate so a decline can never trap the user.
	function setMode(next: 'device' | 'online'): void {
		if (next === 'online' && !onlineCapable) return;
		mode = next;
		if (next === 'device' && state.kind === 'needsReconsent') state = { kind: 'idle' };
	}

	// Confirm the online-egress consent from the gate: record it, go online, and run the held query. The
	// reserved re-consent path (a future non-user-initiated flip) carries no pendingQuery, so it records +
	// returns to idle.
	async function consentOnline(): Promise<void> {
		deps.markOnlineConsent?.();
		const pending = state.kind === 'needsReconsent' ? state.pendingQuery : undefined;
		mode = 'online';
		if (state.kind === 'needsReconsent') state = { kind: 'idle' };
		if (pending) await runOnline(pending);
	}

	// Decline the gate: switch to the device path and answer the held query there, so declining never loses
	// the question (the device path then gates its own one-time setup). Nothing egresses on this path.
	async function stayOnDevice(): Promise<void> {
		if (state.kind !== 'needsReconsent') return;
		const pending = state.pendingQuery;
		mode = 'device';
		state = { kind: 'idle' };
		if (pending) await ask(pending);
	}

	function dismissNudge(): void {
		nudgeDismissed = true;
	}

	return {
		get state(): AskState {
			return state;
		},
		get mode(): 'device' | 'online' {
			return mode;
		},
		get showNudge(): boolean {
			// Invite the fully-private on-device path only after the user has actually used online a couple of
			// times, and never once the device model is already set up or the nudge was dismissed.
			return mode === 'online' && askedCount >= nudgeAfter && !modelLoaded && !nudgeDismissed;
		},
		ask,
		setUp,
		dismissSetup,
		setMode,
		consentOnline,
		stayOnDevice,
		dismissNudge
	};
}
