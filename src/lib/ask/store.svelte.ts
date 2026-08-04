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
 * The Ask view store: holds the `AskState` machine and orchestrates one query. `embed` + `corpus` are
 * injected so the device path is unit-testable without a model/worker.
 *
 * ADDITIVE online seam: when `retrieveOnline` is absent the store is device-only and behaves exactly as
 * before (soft opt-in on-device retrieval). When present, it defaults to online, discloses egress inline,
 * gates a device->online switch behind a blocking re-consent, degrades onto the ladder, and (when synthesis
 * is enabled) attaches an AI-summary view above the cards. The online closures are route-bound so `fetch`,
 * the corpus version, and the raw BYO key never live in the store.
 *
 * Soft opt-in (device path, unchanged): the ~23MB model is NEVER auto-downloaded. The first query on an
 * un-set-up device goes to `needsSetup` with the query preserved; the download happens only when the user
 * consents via `setUp()`. A set-up device (persisted flag) skips straight to `embedding`.
 */
export function createAskStore(deps: {
	embed: (text: string) => Promise<Float32Array>;
	corpus: Corpus;
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
			const vector = await deps.embed(query);
			modelLoaded = true;
			markModelDownloaded();
			const cards = toResultCards(filterByMinScore(search(vector, deps.corpus, K), MIN_SCORE));
			commitIfCurrent(cards.length > 0 ? { kind: 'results', cards } : { kind: 'empty' });
		} catch (e) {
			const code = e instanceof AskError ? e.code : ASK_ERROR.EMBED;
			// Superseded mid-embed (a crisis message routed to help, a pending consent modal) - do not clobber.
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
	// (routed straight to help), a pending consent modal, or a mode change. Only commit if we are still in
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

	// The online path: crisis was already ruled out. The default-online egress is disclosed by the UI (mode +
	// privacy line), so it proceeds without a modal and records consent on the first send. Every transport
	// fault and high-demand response degrades onto the ladder; only a genuine below-threshold server result
	// is `empty`. The BYO key is never read here - synthesize is a route closure that reads it on demand.
	async function runOnline(query: string): Promise<void> {
		state = { kind: 'embedding' };
		deps.markOnlineConsent?.();
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
		// A pending online-consent modal blocks all egress: nothing is sent until the user confirms.
		if (state.kind === 'needsReconsent') return;
		// Ignore a new submit while a query is already running: overlapping runs race on `state`
		// and the later-resolving one would win regardless of submit order.
		if (state.kind === 'modelLoading' || state.kind === 'embedding') return;
		if (mode === 'online' && onlineCapable) {
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

	// Switching UP to online requires a remembered per-device consent; without it, hold at the blocking
	// modal and send nothing until consentOnline() confirms. Switching to device needs no consent.
	function setMode(next: 'device' | 'online'): void {
		if (next === 'online') {
			if (!onlineCapable) return;
			if (deps.onlineConsented?.() ?? false) {
				mode = 'online';
			} else {
				state = { kind: 'needsReconsent' };
			}
			return;
		}
		mode = 'device';
		// Choosing device also dismisses a pending online-consent modal - otherwise "Stay on device" would
		// leave `needsReconsent` up, blocking every query with the only exit being to consent (i.e. egress).
		if (state.kind === 'needsReconsent') state = { kind: 'idle' };
	}

	// Confirm the online-egress consent: record it, go online, and clear the blocking modal.
	function consentOnline(): void {
		deps.markOnlineConsent?.();
		mode = 'online';
		if (state.kind === 'needsReconsent') state = { kind: 'idle' };
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
		dismissNudge
	};
}
