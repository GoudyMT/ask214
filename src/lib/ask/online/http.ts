import type { PlanInput, RetrieveOutcome } from './plan-retrieve';

/**
 * Pull the untrusted inputs off the request. A malformed or missing body yields an undefined query
 * (which planRetrieve maps to `error`); the query is never logged or echoed anywhere.
 */
export async function extractInput(request: Request): Promise<PlanInput> {
	const method = request.method;
	const origin = request.headers.get('origin');
	let rawQuery: unknown = undefined;
	try {
		const body: unknown = await request.json();
		if (body !== null && typeof body === 'object' && 'query' in body) {
			rawQuery = (body as { query: unknown }).query;
		}
	} catch {
		// malformed body -> rawQuery stays undefined -> planRetrieve returns `error`
	}
	return { method, origin, rawQuery };
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

/**
 * Turn a decision outcome into an HTTP response. Rejects are bare status codes; every JSON body is a
 * 200 carrying the discriminated `status` -- the client reads that field, not the HTTP code, to route
 * results / empty / high_demand / error.
 */
export function serialize(outcome: RetrieveOutcome): Response {
	if (outcome.kind === 'reject') {
		return new Response(null, { status: outcome.httpStatus, headers: JSON_HEADERS });
	}
	return new Response(JSON.stringify(outcome.body), { status: 200, headers: JSON_HEADERS });
}
