import { search, toResultCards, type Corpus } from '$lib/corpus';
import { filterByMinScore } from './threshold';
import { detectCrisisIntent } from './crisis/detect';
import { AskError, ASK_ERROR } from './errors';
import type { AskState } from './types';

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
 * The Ask view store (Context 1, on-device): holds the `AskState` machine and orchestrates one query.
 * `embed` + `corpus` are injected so the store is unit-testable without a model/worker.
 *
 * Soft opt-in: the ~23MB model is NEVER auto-downloaded. The first query on an
 * un-set-up device goes to `needsSetup` with the query preserved; the download happens only when the user
 * consents via `setUp()` (which shows `modelLoading` during the one-time fetch, then answers the preserved
 * query). A set-up device (persisted flag) skips straight to `embedding`. A failed FIRST embed with no
 * network surfaces `offline` (connect once to download); any other failure -> `error`.
 */
export function createAskStore(deps: {
	embed: (text: string) => Promise<Float32Array>;
	corpus: Corpus;
}) {
	let state = $state<AskState>({ kind: 'idle' });
	let modelLoaded = readModelDownloaded();

	// The embed -> search -> cards path. The loading state is `modelLoading` on the first run (that embed
	// triggers the one-time ~23MB download) and `embedding` once set up. Shared by ask() (warm) + setUp().
	async function runQuery(query: string): Promise<void> {
		state = modelLoaded ? { kind: 'embedding' } : { kind: 'modelLoading' };
		try {
			const vector = await deps.embed(query);
			modelLoaded = true;
			markModelDownloaded();
			const cards = toResultCards(filterByMinScore(search(vector, deps.corpus, K), MIN_SCORE));
			state = cards.length > 0 ? { kind: 'results', cards } : { kind: 'empty' };
		} catch (e) {
			const code = e instanceof AskError ? e.code : ASK_ERROR.EMBED;
			// Offline only when a first-run (model-not-loaded) embed fails with no network: a warm embed
			// needs no network, so its failure is a genuine error, not connectivity.
			const online = typeof navigator === 'undefined' || navigator.onLine;
			state = !modelLoaded && !online ? { kind: 'offline' } : { kind: 'error', code };
		}
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
		// Ignore a new submit while a query is already running: overlapping runQuery calls race on `state`
		// and the later-resolving one would win regardless of submit order.
		if (state.kind === 'modelLoading' || state.kind === 'embedding') return;
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

	return {
		get state(): AskState {
			return state;
		},
		ask,
		setUp,
		dismissSetup
	};
}
