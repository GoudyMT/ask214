import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Durable Object base comes from the workerd-only `cloudflare:workers` module; stub it so the
// handler graph imports under Node. Breaker is never instantiated here (the BREAKER binding is mocked).
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

// The worker memoizes the decoded corpus at module scope, so reset the module before each test to get a
// fresh load path - a stale memo would leak one test's env (or a failed load) into the next.
beforeEach(() => vi.resetModules());

type Fetcher = (request: Request, env: unknown) => Promise<Response>;
async function loadFetch(): Promise<Fetcher> {
	const mod = await import('./index');
	return (mod.default as unknown as { fetch: Fetcher }).fetch;
}

const MODEL = '@cf/baai/bge-small-en-v1.5';

// A minimal VALID bge index: 1 chunk, dim 2, model id the worker decodes under. `[3,4]` normalizes to
// `[0.6,0.8]`, so a query embedded to the same vector scores ~1.0 (above the 0.6 cutoff).
function manifest(): unknown {
	return {
		version: '1.0',
		dim: 2,
		modelId: MODEL,
		chunks: [
			{
				id: 'c1',
				text: 'VA disability basics',
				sourceId: 's1',
				sourceTitle: 'VA',
				tags: [],
				url: 'https://va.gov/'
			}
		]
	};
}
function embeddings(): ArrayBuffer {
	return new Float32Array([3, 4]).buffer;
}

interface Overrides {
	kvGet?: (key: string, type?: string) => Promise<unknown>;
	aiRun?: () => Promise<unknown>;
	degraded?: boolean;
	limit?: () => Promise<{ success: boolean }>;
}
function env(o: Overrides = {}) {
	const defaultKvGet = async (key: string): Promise<unknown> => {
		if (key === 'corpus-bge-manifest') return manifest();
		if (key === 'corpus-bge-embeddings') return embeddings();
		return null;
	};
	return {
		CORPUS_KV: { get: vi.fn(o.kvGet ?? defaultKvGet) },
		AI: { run: vi.fn(o.aiRun ?? (async () => ({ data: [[0.6, 0.8]] }))) },
		BREAKER: { getByName: () => ({ reserve: async () => o.degraded ?? false }) },
		RETRIEVE_LIMITER: o.limit ? { limit: vi.fn(o.limit) } : undefined
	};
}
function post(query: unknown, origin: string | null = 'https://ask214.com'): Request {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'cf-connecting-ip': '203.0.113.7'
	};
	if (origin !== null) headers.origin = origin;
	return new Request('https://ask214.com/api/retrieve', {
		method: 'POST',
		headers,
		body: JSON.stringify({ query })
	});
}

type Body =
	| {
			status: 'results';
			results: Array<{ score: number; chunk: { id: string } }>;
			corpusVersion: string;
	  }
	| { status: 'empty'; corpusVersion: string }
	| { status: 'high_demand' }
	| { status: 'error' };

describe('retrieve worker fetch wiring', () => {
	it('serves a cited result for a valid query (KV keys, decode, AI extract, search all wired)', async () => {
		const fetch = await loadFetch();
		const e = env();
		const res = await fetch(post('va disability'), e);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Body;
		if (body.status !== 'results') throw new Error('expected a results body');
		expect(body.results[0]?.chunk.id).toBe('c1');
		// Read under the EXACT keys the index was written with; a typo -> null -> E_INDEX_MISSING -> error.
		expect(e.CORPUS_KV.get).toHaveBeenCalledWith('corpus-bge-manifest', 'json');
		expect(e.CORPUS_KV.get).toHaveBeenCalledWith('corpus-bge-embeddings', 'arrayBuffer');
	});

	it('maps a missing KV index to error, never a crash (E_INDEX_MISSING)', async () => {
		const fetch = await loadFetch();
		const res = await fetch(post('x'), env({ kvGet: async () => null }));
		expect(((await res.json()) as Body).status).toBe('error');
	});

	it('maps an empty AI embed response to error (the data-extraction guard)', async () => {
		const fetch = await loadFetch();
		const res = await fetch(post('x'), env({ aiRun: async () => ({}) }));
		expect(((await res.json()) as Body).status).toBe('error');
	});

	it('degrades to high_demand when the breaker is tripped', async () => {
		const fetch = await loadFetch();
		const res = await fetch(post('x'), env({ degraded: true }));
		expect(((await res.json()) as Body).status).toBe('high_demand');
	});

	it('degrades to high_demand when the per-IP rate limit is hit', async () => {
		const fetch = await loadFetch();
		const res = await fetch(post('x'), env({ limit: async () => ({ success: false }) }));
		expect(((await res.json()) as Body).status).toBe('high_demand');
	});

	it('rejects a non-POST method with 405', async () => {
		const fetch = await loadFetch();
		const req = new Request('https://ask214.com/api/retrieve', {
			method: 'GET',
			headers: { origin: 'https://ask214.com' }
		});
		expect((await fetch(req, env())).status).toBe(405);
	});

	it('rejects a disallowed origin with 403', async () => {
		const fetch = await loadFetch();
		expect((await fetch(post('x', 'https://evil.example'), env())).status).toBe(403);
	});
});
