import { describe, it, expect } from 'vitest';
import { fuseHybrid } from './hybrid';

const P = { alpha: 0.5, minScore: 0, minBm25: 0.0001 };

describe('fuseHybrid', () => {
	it('combines cosine + per-query-normalized bm25, returns top-k eligible best-first', () => {
		// bm25 max = 2 -> norm [1, 0, 0.5]. combined(a=0.5): doc0=0.8, doc2=0.65. doc1 gated (bm25 0).
		const out = fuseHybrid([0.6, 0.5, 0.8], [2, 0, 1], 2, P);
		expect(out.map((r) => r.index)).toEqual([0, 2]);
	});

	it('returns empty when no doc has lexical grounding (off-corpus -> bm25 all 0)', () => {
		expect(fuseHybrid([0.7, 0.65], [0, 0], 5, P)).toEqual([]);
	});

	it('drops results below minScore', () => {
		expect(fuseHybrid([0.2], [1], 5, { ...P, minScore: 0.9 })).toEqual([]);
	});

	it('respects k', () => {
		expect(fuseHybrid([0.3, 0.4, 0.5], [1, 1, 1], 2, P)).toHaveLength(2);
	});
});
