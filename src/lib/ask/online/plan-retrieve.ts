import { isAllowedOrigin } from './origin-check';
import { capQuery } from './query-cap';

/** A single scored retrieval hit; the chunk shape is left open so the client owns rendering. */
export interface Scored {
	score: number;
	chunk: unknown;
}

/** The JSON body returned to the client -- the discriminated status contract (red-team C6). */
export type RetrieveBody =
	| { status: 'results'; results: Scored[]; corpusVersion: string }
	| { status: 'empty'; corpusVersion: string }
	| { status: 'high_demand' }
	| { status: 'error' };

/** The Worker shell maps this to an HTTP response: a hard reject, or a JSON body. */
export type RetrieveOutcome =
	{ kind: 'reject'; httpStatus: 405 | 403 } | { kind: 'respond'; body: RetrieveBody };

export interface PlanInput {
	method: string;
	origin: string | null;
	rawQuery: unknown;
}

export interface PlanDeps {
	allowedOrigins: string[];
	maxQueryChars: number;
	minScore: number;
	corpusVersion: string;
	/** Per-IP rate limit: true = over the limit -> degrade to high_demand. Checked LAZILY (only for a
	 * valid, non-empty query) and BEFORE the breaker, so a limited request reserves no global budget. */
	checkRateLimit: () => Promise<boolean>;
	/** Reserve budget + report whether to degrade. Checked LAZILY -- only for a valid, non-empty query
	 * that is about to embed -- so malformed/empty requests cannot inflate the counter. */
	checkBreaker: () => Promise<boolean>;
	embed: (query: string) => Promise<number[]>;
	search: (embedding: number[]) => Scored[];
}

/**
 * The pure retrieve decision path. Cheap gates first (method, origin), then the query is validated and
 * capped; only a valid non-empty query touches the circuit-breaker and embeds. Only a genuine
 * below-threshold search returns `empty`; any breaker/embed/search failure returns `error` WITHOUT
 * carrying the query. Deps are injected so the whole path is node-testable; the Worker shell binds the
 * Durable Object breaker, Workers AI, and the corpus index.
 *
 * @param input Method, Origin header, and the raw request-body query (untrusted).
 * @param deps Config + injected breaker/embed/search.
 * @returns A hard reject (405/403) or a JSON status body.
 */
export async function planRetrieve(input: PlanInput, deps: PlanDeps): Promise<RetrieveOutcome> {
	if (input.method !== 'POST') return { kind: 'reject', httpStatus: 405 };
	if (!isAllowedOrigin(input.origin, deps.allowedOrigins))
		return { kind: 'reject', httpStatus: 403 };
	if (typeof input.rawQuery !== 'string') return { kind: 'respond', body: { status: 'error' } };

	const query = capQuery(input.rawQuery, deps.maxQueryChars);
	if (query.length === 0) {
		return { kind: 'respond', body: { status: 'empty', corpusVersion: deps.corpusVersion } };
	}

	try {
		if (await deps.checkRateLimit()) return { kind: 'respond', body: { status: 'high_demand' } };
		if (await deps.checkBreaker()) return { kind: 'respond', body: { status: 'high_demand' } };
		const embedding = await deps.embed(query);
		const hits = deps.search(embedding).filter((h) => h.score >= deps.minScore);
		if (hits.length === 0) {
			return { kind: 'respond', body: { status: 'empty', corpusVersion: deps.corpusVersion } };
		}
		return {
			kind: 'respond',
			body: { status: 'results', results: hits, corpusVersion: deps.corpusVersion }
		};
	} catch {
		return { kind: 'respond', body: { status: 'error' } };
	}
}
