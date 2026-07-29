import { describe, it, expect, vi } from 'vitest';
import { planRetrieve, type PlanDeps } from './plan-retrieve';

function deps(over: Partial<PlanDeps> = {}): PlanDeps {
	return {
		allowedOrigins: ['https://ask214.com'],
		maxQueryChars: 512,
		minScore: 0.65,
		corpusVersion: '1.0',
		breakerTripped: false,
		embed: async () => [0.1, 0.2],
		search: () => [{ score: 0.9, chunk: { id: 'c1' } }],
		...over
	};
}

const ok = { method: 'POST', origin: 'https://ask214.com' };

describe('planRetrieve', () => {
	it('rejects a non-POST method with 405', async () => {
		const r = await planRetrieve({ ...ok, method: 'GET', rawQuery: 'x' }, deps());
		expect(r).toEqual({ kind: 'reject', httpStatus: 405 });
	});

	it('rejects a disallowed origin with 403', async () => {
		const r = await planRetrieve({ ...ok, origin: 'https://evil.example', rawQuery: 'x' }, deps());
		expect(r).toEqual({ kind: 'reject', httpStatus: 403 });
	});

	it('returns high_demand when the breaker is tripped, without embedding', async () => {
		const embed = vi.fn(async () => [1]);
		const r = await planRetrieve({ ...ok, rawQuery: 'x' }, deps({ breakerTripped: true, embed }));
		expect(r).toEqual({ kind: 'respond', body: { status: 'high_demand' } });
		expect(embed).not.toHaveBeenCalled();
	});

	it('returns error for a non-string query body', async () => {
		const r = await planRetrieve({ ...ok, rawQuery: undefined }, deps());
		expect(r).toEqual({ kind: 'respond', body: { status: 'error' } });
	});

	it('returns empty for a whitespace-only query, without embedding', async () => {
		const embed = vi.fn(async () => [1]);
		const r = await planRetrieve({ ...ok, rawQuery: '   ' }, deps({ embed }));
		expect(r).toEqual({ kind: 'respond', body: { status: 'empty', corpusVersion: '1.0' } });
		expect(embed).not.toHaveBeenCalled();
	});

	it('returns results (above MIN_SCORE only) with the corpus version', async () => {
		const r = await planRetrieve(
			{ ...ok, rawQuery: 'benefits' },
			deps({
				search: () => [
					{ score: 0.9, chunk: { id: 'c1' } },
					{ score: 0.5, chunk: { id: 'c2' } }
				]
			})
		);
		expect(r).toEqual({
			kind: 'respond',
			body: {
				status: 'results',
				results: [{ score: 0.9, chunk: { id: 'c1' } }],
				corpusVersion: '1.0'
			}
		});
	});

	it('returns empty when every hit falls below MIN_SCORE', async () => {
		const r = await planRetrieve(
			{ ...ok, rawQuery: 'unrelated' },
			deps({ search: () => [{ score: 0.3, chunk: { id: 'c1' } }] })
		);
		expect(r).toEqual({ kind: 'respond', body: { status: 'empty', corpusVersion: '1.0' } });
	});

	it('maps an embed failure to error (query never leaks)', async () => {
		const r = await planRetrieve(
			{ ...ok, rawQuery: 'boom' },
			deps({
				embed: async () => {
					throw new Error('AI down');
				}
			})
		);
		expect(r).toEqual({ kind: 'respond', body: { status: 'error' } });
	});
});
