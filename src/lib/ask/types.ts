import type { ResultCard } from '$lib/corpus';
import type { AskErrorCode } from './errors';

/** The embedding model C uses for the query. MUST equal the corpus manifest's modelId. */
export const EMBED_MODEL_ID = 'all-MiniLM-L6-v2';

/** Worker message protocol (structured-clone-safe; the vector transfers ownership). */
export type EmbedRequest = { id: number; text: string };
export type EmbedResponse =
	| { id: number; ok: true; vector: Float32Array }
	| { id: number; ok: false; code: string };

/** The Ask view state machine (drives the UI). */
export type AskState =
	| { kind: 'idle' }
	| { kind: 'needsSetup'; pendingQuery: string } // soft opt-in: asked, model not set up; query preserved
	| { kind: 'modelLoading' }
	| { kind: 'embedding' }
	| { kind: 'results'; cards: ResultCard[] }
	| { kind: 'empty' }
	| { kind: 'offline' }
	| { kind: 'error'; code: AskErrorCode };
