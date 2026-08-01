import { buildRetrieveBody, assertOnlyKeys } from './payload';
import type { RetrieveResult } from './outcome';

// Injected so the unit is deterministic; the route binds the real global fetch. Narrowed to the string
// URL + required init this caller passes.
export type FetchLike = (url: string, options: RequestInit) => Promise<Response>;

export interface RetrieveOnlineDeps {
	fetch: FetchLike;
	// The corpus version the client's citation rendering expects. A server answering on a different version
	// is treated as unavailable rather than trusted -- a refresh can move or drop a passage the answer cites.
	expectedCorpusVersion: string;
}

const RETRIEVE_ENDPOINT = '/api/retrieve';

/**
 * POST a query to the retrieval Worker and return the discriminated outcome.
 *
 * Every transport failure (throw, non-ok, malformed body) and every corpus-version mismatch collapses to
 * `error` -- never `empty`, which would misreport a network fault as an authoritative "no source exists".
 *
 * @param query The user's raw question.
 * @param deps Injected fetch + the expected corpus version.
 * @returns The retrieve result the client seam consumes.
 */
export async function retrieveOnline(
	query: string,
	deps: RetrieveOnlineDeps
): Promise<RetrieveResult> {
	const body = buildRetrieveBody(query);
	assertOnlyKeys(body, ['query']); // structural egress guard: the body is exactly {query}

	let res: Response;
	try {
		res = await deps.fetch(RETRIEVE_ENDPOINT, {
			method: 'POST',
			credentials: 'omit',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
	} catch {
		return { status: 'error' };
	}
	if (!res.ok) return { status: 'error' };

	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		return { status: 'error' };
	}
	return normalize(parsed, deps.expectedCorpusVersion);
}

// Map the server JSON to the client union, enforcing the corpus-version handshake on the two status bodies
// that carry a version. An unknown or malformed body is unavailable, not empty.
function normalize(parsed: unknown, expectedVersion: string): RetrieveResult {
	if (parsed === null || typeof parsed !== 'object') return { status: 'error' };
	const body = parsed as Record<string, unknown>;
	const versionOk = body.corpusVersion === expectedVersion;
	switch (body.status) {
		case 'results':
			return versionOk && Array.isArray(body.results)
				? { status: 'results', results: body.results as unknown[], corpusVersion: expectedVersion }
				: { status: 'error' };
		case 'empty':
			return versionOk ? { status: 'empty', corpusVersion: expectedVersion } : { status: 'error' };
		case 'high_demand':
			return { status: 'high_demand' };
		default:
			return { status: 'error' };
	}
}
