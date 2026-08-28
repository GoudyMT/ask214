import { planRetrieve, type PlanDeps } from '../../../src/lib/ask/online/plan-retrieve';
import { extractInput, serialize } from '../../../src/lib/ask/online/http';
import { createCachedLoader } from '../../../src/lib/ask/online/corpus-cache';
import { search as searchCorpus } from '../../../src/lib/corpus/search';
import { decodeCorpus } from '../../../src/lib/corpus/codec';
import type { Corpus, CorpusManifest } from '../../../src/lib/corpus/types';
import { Breaker } from './breaker';

export { Breaker };

export interface Env {
	AI: Ai;
	CORPUS_KV: KVNamespace;
	BREAKER: DurableObjectNamespace<Breaker>;
	// Per-IP rate limit (optional: absent in local dev -> the handler fails open).
	RETRIEVE_LIMITER?: RateLimit;
}

// Config-as-invariant (ADR-025). bge is asymmetric: the QUERY carries an instruction prefix, passages do
// not (G1: query-prefix wins on MRR). QUERY_PREFIX + MIN_SCORE + BGE_MODEL_ID must match the values the
// index was built and evaluated with -- pinned when the index is built.
const ALLOWED_ORIGINS = ['https://ask214.com'];
const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
const BGE_MODEL_ID = '@cf/baai/bge-small-en-v1.5';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const MAX_QUERY_CHARS = 400;
const MIN_SCORE = 0.6; // held-out-calibrated cutoff (highest holding the 0.80/0.60 ranking floor)
const TOP_K = 5;
const EST_NEURONS_PER_QUERY = 1;
const MANIFEST_KEY = 'corpus-bge-manifest';
const EMBEDDINGS_KEY = 'corpus-bge-embeddings';

// The index is loaded once per isolate and held in memory; a cold start pays one KV read, warm requests
// are instant. Concurrent cold requests share one load, and a rejected load clears the memo so a later
// request retries instead of the isolate serving the failure until it recycles.
let cachedCorpus: (() => Promise<Corpus>) | null = null;
function loadCorpus(env: Env): Promise<Corpus> {
	if (cachedCorpus === null) {
		cachedCorpus = createCachedLoader<Corpus>(async () => {
			const manifest = await env.CORPUS_KV.get<CorpusManifest>(MANIFEST_KEY, 'json');
			const buffer = await env.CORPUS_KV.get(EMBEDDINGS_KEY, 'arrayBuffer');
			if (manifest === null || buffer === null) throw new Error('E_INDEX_MISSING');
			return decodeCorpus(manifest, buffer, BGE_MODEL_ID);
		});
	}
	return cachedCorpus();
}

function utcDay(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 10);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			const input = await extractInput(request);
			const corpus = await loadCorpus(env);
			const deps: PlanDeps = {
				allowedOrigins: ALLOWED_ORIGINS,
				maxQueryChars: MAX_QUERY_CHARS,
				minScore: MIN_SCORE,
				corpusVersion: corpus.version,
				checkRateLimit: async () => {
					const limiter = env.RETRIEVE_LIMITER;
					if (!limiter) return false; // fail open in local dev (no binding)
					const { success } = await limiter.limit({
						key: request.headers.get('cf-connecting-ip') ?? 'unknown'
					});
					return !success; // true = over the per-IP limit -> degrade to high_demand
				},
				checkBreaker: () =>
					env.BREAKER.getByName('global').reserve(utcDay(Date.now()), EST_NEURONS_PER_QUERY),
				embed: async (query) => {
					const out = await env.AI.run(EMBED_MODEL, { text: [QUERY_PREFIX + query] });
					// bge's run() type is a union (the sync result vs an async-queue response) whose `data` is
					// optional; we call it synchronously, so pull the first embedding and fail closed otherwise.
					const data = 'data' in out ? out.data : undefined;
					const vector = data?.[0];
					if (vector === undefined) throw new Error('E_EMBED_EMPTY');
					return vector;
				},
				search: (embedding) =>
					searchCorpus(embedding, corpus, TOP_K).map((r) => ({ score: r.score, chunk: r.chunk }))
			};
			return serialize(await planRetrieve(input, deps));
		} catch {
			return serialize({ kind: 'respond', body: { status: 'error' } });
		}
	}
} satisfies ExportedHandler<Env>;
