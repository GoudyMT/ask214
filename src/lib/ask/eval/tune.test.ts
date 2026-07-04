import { describe, it, expect } from 'vitest';
import { evalUnderParams, gridSearch, deriveMinBm25Candidates, type CachedQuery } from './tune';
import type { GroundTruthQuery, HardNegativeQuery } from './resolve-ground-truth';

const posItem = (query: string, sourceId: string): GroundTruthQuery => ({
	query,
	sourceId,
	answerSnippet: 'x'
});
const negItem = (query: string): HardNegativeQuery => ({ query, expectEmpty: true });

// Two chunks; sourceIds aligned to the cosine/bm25 index position.
const chunkSourceIds = ['s1', 's2'];
const cache: CachedQuery[] = [
	{ item: posItem('qa', 's1'), cosine: [0.9, 0.2], bm25: [4, 1] }, // right source s1 ranks first
	{ item: posItem('qb', 's2'), cosine: [0.8, 0.3], bm25: [2, 2] }, // right source s2 ranks second
	{ item: negItem('qn'), cosine: [0.5, 0.4], bm25: [0, 0] } // off-corpus: zero lexical overlap
];

describe('evalUnderParams', () => {
	it('scores source hitRate + MRR over positives and correct-empty over hard-negatives', () => {
		// minBm25 0.01 gates the zero-overlap negative to empty; alpha 1 ranks by cosine.
		const m = evalUnderParams(cache, chunkSourceIds, { alpha: 1, minScore: 0, minBm25: 0.01 }, 5);
		expect(m.srcHitRate).toBe(1); // both right sources land in top-5
		expect(m.srcMRR).toBe(0.75); // s1 at rank 1 (1.0) + s2 at rank 2 (0.5), averaged
		expect(m.correctEmpty).toBe(1); // the hard-negative returns nothing
	});

	it('honors k: at k=1 the rank-2 right source is a miss', () => {
		const m = evalUnderParams(cache, chunkSourceIds, { alpha: 1, minScore: 0, minBm25: 0.01 }, 1);
		expect(m.srcHitRate).toBe(0.5); // qa hits at rank 1; qb misses (s1 is top-1)
		expect(m.srcMRR).toBe(0.5); // 1.0 + 0, averaged
	});

	it('minBm25 = 0 removes the lexical gate, so the off-corpus negative leaks (not empty)', () => {
		const m = evalUnderParams(cache, chunkSourceIds, { alpha: 1, minScore: 0, minBm25: 0 }, 5);
		expect(m.correctEmpty).toBe(0); // zero-bm25 chunks are no longer filtered out
	});

	it('credits an altSource when the primary source is not retrieved', () => {
		// primary s3 is absent from the corpus; the altSource s1 is at rank 1 -> the query counts as a hit.
		const alt: CachedQuery[] = [
			{
				item: { query: 'qc', sourceId: 's3', answerSnippet: 'x', altSources: ['s1'] },
				cosine: [0.9, 0.2],
				bm25: [1, 1]
			}
		];
		const m = evalUnderParams(alt, chunkSourceIds, { alpha: 1, minScore: 0, minBm25: 0 }, 5);
		expect(m.srcHitRate).toBe(1); // s1 (altSource) is in top-5
		expect(m.srcMRR).toBe(1); // s1 at rank 1
	});
});

describe('deriveMinBm25Candidates', () => {
	it('returns 0 plus the 25/50/75th percentiles of the observed values, deduped ascending', () => {
		expect(deriveMinBm25Candidates([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([0, 3, 5, 7]);
	});

	it('dedupes when percentiles coincide', () => {
		expect(deriveMinBm25Candidates([2, 2, 2])).toEqual([0, 2]);
	});

	it('falls back to [0] (no lexical gate) when there are no values', () => {
		expect(deriveMinBm25Candidates([])).toEqual([0]);
	});
});

describe('gridSearch', () => {
	it('maximizes ranking (srcHitRate + srcMRR) and does NOT reward correct-empty', () => {
		// Both minScore values keep the positives (identical ranking); minScore 0.7 only ADDS correct-empty
		// by filtering the off-corpus negative to empty. A ranking-only objective is indifferent to that, so
		// the tie resolves to the first combo (minScore 0). (The former srcHitRate+srcMRR+correctEmpty
		// objective would have picked minScore 0.7 for the correct-empty bonus - which v1.0 no longer gates on.)
		const set: CachedQuery[] = [
			{ item: posItem('qa', 's1'), cosine: [0.9, 0.1], bm25: [1, 1] },
			{ item: posItem('qb', 's2'), cosine: [0.1, 0.9], bm25: [1, 1] },
			{ item: negItem('qn'), cosine: [0.5, 0.5], bm25: [0, 0] }
		];
		const best = gridSearch(
			set,
			chunkSourceIds,
			{ alpha: [1], minBm25: [0], minScore: [0, 0.7] },
			5
		);
		expect(best.params.minScore).toBe(0);
		expect(best.metrics.correctEmpty).toBe(0);
	});
});
