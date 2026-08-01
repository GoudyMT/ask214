import { describe, it, expect, vi } from 'vitest';
import { retrieveOnline, type RetrieveOnlineDeps, type FetchLike } from './retrieve-online';

const VERSION = '1.0';

function stubFetch(
	body: unknown,
	init: { ok?: boolean; status?: number; throws?: boolean; badJson?: boolean } = {}
) {
	const impl = vi.fn<FetchLike>(async (): Promise<Response> => {
		if (init.throws) throw new Error('network down');
		return {
			ok: init.ok ?? true,
			status: init.status ?? 200,
			json: async () => {
				if (init.badJson) throw new Error('bad json');
				return body;
			}
		} as Response;
	});
	return impl;
}

function deps(fetchImpl: RetrieveOnlineDeps['fetch']): RetrieveOnlineDeps {
	return { fetch: fetchImpl, expectedCorpusVersion: VERSION };
}

describe('retrieveOnline', () => {
	it('returns results when the corpusVersion matches', async () => {
		const impl = stubFetch({
			status: 'results',
			results: [{ score: 0.7, chunk: { id: 'a' } }],
			corpusVersion: VERSION
		});
		const r = await retrieveOnline('skillbridge', deps(impl));
		expect(r).toEqual({
			status: 'results',
			results: [{ score: 0.7, chunk: { id: 'a' } }],
			corpusVersion: VERSION
		});
	});

	it('degrades a results corpusVersion MISMATCH to error (never a stale citation)', async () => {
		const impl = stubFetch({
			status: 'results',
			results: [{ score: 0.7, chunk: {} }],
			corpusVersion: '0.9'
		});
		expect(await retrieveOnline('q', deps(impl))).toEqual({ status: 'error' });
	});

	it('returns empty when the corpusVersion matches', async () => {
		const impl = stubFetch({ status: 'empty', corpusVersion: VERSION });
		expect(await retrieveOnline('q', deps(impl))).toEqual({
			status: 'empty',
			corpusVersion: VERSION
		});
	});

	it('degrades an empty corpusVersion mismatch to error', async () => {
		const impl = stubFetch({ status: 'empty', corpusVersion: '0.9' });
		expect(await retrieveOnline('q', deps(impl))).toEqual({ status: 'error' });
	});

	it('passes high_demand through to the degrade ladder', async () => {
		const impl = stubFetch({ status: 'high_demand' });
		expect(await retrieveOnline('q', deps(impl))).toEqual({ status: 'high_demand' });
	});

	it('maps a server error status to error', async () => {
		const impl = stubFetch({ status: 'error' });
		expect(await retrieveOnline('q', deps(impl))).toEqual({ status: 'error' });
	});

	it('maps a transport throw to error, NOT empty', async () => {
		const impl = stubFetch(null, { throws: true });
		expect(await retrieveOnline('q', deps(impl))).toEqual({ status: 'error' });
	});

	it('maps a non-ok response (reject) to error', async () => {
		const impl = stubFetch(null, { ok: false, status: 403 });
		expect(await retrieveOnline('q', deps(impl))).toEqual({ status: 'error' });
	});

	it('maps malformed JSON to error', async () => {
		const impl = stubFetch(null, { badJson: true });
		expect(await retrieveOnline('q', deps(impl))).toEqual({ status: 'error' });
	});

	it('maps an unrecognized status to error', async () => {
		const impl = stubFetch({ status: 'weird' });
		expect(await retrieveOnline('q', deps(impl))).toEqual({ status: 'error' });
	});

	it('POSTs credentials-omit with a {query}-only trimmed body', async () => {
		const impl = stubFetch({ status: 'empty', corpusVersion: VERSION });
		await retrieveOnline('  skillbridge  ', deps(impl));
		expect(impl).toHaveBeenCalledTimes(1);
		const [url, options] = impl.mock.calls[0]!;
		expect(url).toBe('/api/retrieve');
		expect(options.method).toBe('POST');
		expect(options.credentials).toBe('omit');
		expect(options.body).toBe(JSON.stringify({ query: 'skillbridge' }));
	});
});
