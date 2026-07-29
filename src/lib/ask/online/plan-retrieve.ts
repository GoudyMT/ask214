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
	breakerTripped: boolean;
	embed: (query: string) => Promise<number[]>;
	search: (embedding: number[]) => Scored[];
}

/**
 * The pure retrieve decision path. Global gates first (method, origin, circuit-breaker), then the
 * per-request work (embed + search + MIN_SCORE). Only a genuine below-threshold search returns `empty`;
 * any embed/search failure returns `error` WITHOUT carrying the query. Deps are injected so the whole
 * path is node-testable; the Worker shell binds real Workers AI + the corpus index.
 *
 * @param input Method, Origin header, and the raw request-body query (untrusted).
 * @param deps Config + injected embed/search + the circuit-breaker decision.
 * @returns A hard reject (405/403) or a JSON status body.
 */
export async function planRetrieve(input: PlanInput, deps: PlanDeps): Promise<RetrieveOutcome> {
	if (input.method !== 'POST') return { kind: 'reject', httpStatus: 405 };
	if (!isAllowedOrigin(input.origin, deps.allowedOrigins))
		return { kind: 'reject', httpStatus: 403 };
	if (deps.breakerTripped) return { kind: 'respond', body: { status: 'high_demand' } };
	if (typeof input.rawQuery !== 'string') return { kind: 'respond', body: { status: 'error' } };

	const query = capQuery(input.rawQuery, deps.maxQueryChars);
	if (query.length === 0) {
		return { kind: 'respond', body: { status: 'empty', corpusVersion: deps.corpusVersion } };
	}

	try {
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
