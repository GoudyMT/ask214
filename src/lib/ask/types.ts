import type { ResultCard } from '$lib/corpus';
import type { AskErrorCode } from './errors';
import type { Rung } from './online/ladder';
import type { SynthesisView } from './synthesis/synthesis-view';

/** The embedding model C uses for the query. MUST equal the corpus manifest's modelId. */
export const EMBED_MODEL_ID = 'all-MiniLM-L6-v2';

/** Worker message protocol (structured-clone-safe; the vector transfers ownership). */
export type EmbedRequest = { id: number; text: string };
export type EmbedResponse =
	{ id: number; ok: true; vector: Float32Array } | { id: number; ok: false; code: string };

/** The Ask view state machine (drives the UI). */
export type AskState =
	| { kind: 'idle' }
	| { kind: 'needsSetup'; pendingQuery: string } // soft opt-in: asked, model not set up; query preserved
	| { kind: 'needsReconsent'; pendingQuery?: string } // first-egress consent gate: the first online query on a not-yet-consented device is held here with its query; also the reserved re-consent for a future non-user-initiated flip
	| { kind: 'modelLoading' }
	| { kind: 'embedding' } // generic "working" state (device embed OR an online retrieve in flight)
	| {
			kind: 'results';
			// The path that produced these cards, snapshot at answer time. The privacy copy (the reader's
			// on-device assurance and the always-visible line) derives from THIS, never the live mode - so a
			// later mode toggle over a displayed answer can never relabel where it actually came from.
			origin: 'device' | 'online';
			cards: ResultCard[];
			summary?: SynthesisView; // present only on the online+synthesis path
	  }
	| { kind: 'empty' }
	| { kind: 'offline' }
	| { kind: 'degraded'; rung: Rung; query: string } // an online path failed this session; rung = next offer, query = kept for the retry
	| { kind: 'crisis' } // a crisis / self-harm message: routed straight to help, never retrieved or synthesized
	| { kind: 'error'; code: AskErrorCode };
