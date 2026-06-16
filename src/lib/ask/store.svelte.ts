import { search, toResultCards, type Corpus } from '$lib/corpus';
import { filterByMinScore } from './threshold';
import { AskError, ASK_ERROR } from './errors';
import type { AskState } from './types';

const K = 5; // result cards per query (spec 4.6: 3-5)
// Minimum cosine score a hit must clear to surface (spec section 9): weak matches are dropped rather
// than padded in, which is also what makes `empty` reachable. Calibrated against the eval set - set
// below the weakest relevant lead so a valid answer is never dropped, and above the off-topic noise
// tail so unrelated hits collapse. Recalibrate as the corpus scales (spec section 15 #1).
const MIN_SCORE = 0.4;

// The ~23MB on-device search model is fetched + cached once, then served from cache forever (ADR-014).
// We persist one non-PII boolean - "was the model downloaded on this device?" - so the "downloading..."
// modelLoading message shows on the first-EVER query only, not once per session (spec section 9). This
// is a device-capability flag, NOT user data (no query, no profile, nothing personal), so plain
// localStorage is correct here - ADR-004's encrypted-IDB rule governs PII, which this is not.
const MODEL_DOWNLOADED_KEY = 'mtc:ask:model-downloaded';

function readModelDownloaded(): boolean {
	return typeof localStorage !== 'undefined' && localStorage.getItem(MODEL_DOWNLOADED_KEY) === '1';
}

function markModelDownloaded(): void {
	if (typeof localStorage !== 'undefined') localStorage.setItem(MODEL_DOWNLOADED_KEY, '1');
}

/**
 * The Ask view store (Context 1, on-device): holds the `AskState` machine and orchestrates one query.
 * `embed` + `corpus` are injected so the store is unit-testable without a model/worker. The first query
 * shows `modelLoading` (the one-time ~23MB model load is folded into it - Option A, no progress %);
 * subsequent queries show `embedding`. A failed embed while the model is not yet loaded AND the device
 * is offline surfaces `offline` (first-run-offline: connect once to download); any other failure -> `error`.
 */
export function createAskStore(deps: {
	embed: (text: string) => Promise<Float32Array>;
	corpus: Corpus;
}) {
	let state = $state<AskState>({ kind: 'idle' });
	let modelLoaded = readModelDownloaded();

	async function ask(query: string): Promise<void> {
		if (query.trim() === '') return; // ignore empty submits
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

	return {
		get state(): AskState {
			return state;
		},
		ask
	};
}
