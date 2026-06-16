import { describe, it, expect } from 'vitest';
import { filterByMinScore } from './threshold';
import type { RetrievalResult, CorpusChunk } from '$lib/corpus';

// The chunk content is irrelevant to filterByMinScore (only `score` drives the decision), so this
// builds a minimal valid CorpusChunk and tags each result with a distinct id for ordering assertions.
function result(id: string, score: number): RetrievalResult {
	const chunk: CorpusChunk = { id, text: id, sourceId: 's', sourceTitle: 'S', tags: [], url: 'u' };
	return { chunk, score };
}

describe('filterByMinScore', () => {
	// Edge case 1: empty input -> empty output (nothing to filter).
	it('returns [] for an empty input array', () => {
		expect(filterByMinScore([], 0.5)).toEqual([]);
	});

	// Edge case 2: every score strictly below the threshold -> nothing survives.
	it('returns [] when all scores are strictly below minScore', () => {
		const input = [result('a', 0.1), result('b', 0.49), result('c', -1)];
		expect(filterByMinScore(input, 0.5)).toEqual([]);
	});

	// Edge case 3: every score at or above the threshold -> all survive, order preserved.
	it('returns all results (order preserved) when every score is at or above minScore', () => {
		const input = [result('a', 0.9), result('b', 0.5), result('c', 1)];
		const kept = filterByMinScore(input, 0.5);
		expect(kept.map((r) => r.chunk.id)).toEqual(['a', 'b', 'c']);
		expect(kept.map((r) => r.score)).toEqual([0.9, 0.5, 1]);
	});

	// Edge case 4: mixed scores -> only the qualifying ones survive, in original order.
	// Input order is deliberately not sorted so the assertion pins relative order, not just membership.
	it('keeps only qualifying results and preserves their original order (mixed scores)', () => {
		const input = [
			result('a', 0.2), // dropped
			result('b', 0.8), // kept
			result('c', 0.49), // dropped
			result('d', 0.5), // kept (boundary)
			result('e', -0.3), // dropped
			result('f', 0.95) // kept
		];
		const kept = filterByMinScore(input, 0.5);
		expect(kept.map((r) => r.chunk.id)).toEqual(['b', 'd', 'f']);
		expect(kept.map((r) => r.score)).toEqual([0.8, 0.5, 0.95]);
	});

	// Edge case 5: a score EXACTLY equal to minScore is KEPT. This distinguishes `>=` from `>`:
	// a `>`-based implementation would drop 'a' and fail this test.
	it('keeps a result whose score is exactly equal to minScore (inclusive boundary, >= not >)', () => {
		const input = [result('a', 0.5)];
		const kept = filterByMinScore(input, 0.5);
		expect(kept).toHaveLength(1);
		expect(kept[0]!.chunk.id).toBe('a');
		expect(kept[0]!.score).toBe(0.5);
	});

	// Edge case 6: purity -- the input array must not be mutated by the call.
	it('does not mutate the input array', () => {
		const input = [result('a', 0.2), result('b', 0.8), result('c', 0.5)];
		const snapshotIds = input.map((r) => r.chunk.id);
		const snapshotScores = input.map((r) => r.score);
		const snapshotLength = input.length;

		filterByMinScore(input, 0.5);

		expect(input).toHaveLength(snapshotLength);
		expect(input.map((r) => r.chunk.id)).toEqual(snapshotIds);
		expect(input.map((r) => r.score)).toEqual(snapshotScores);
	});

	// Reinforces purity from the other direction: the returned array is a NEW reference,
	// not the same array object handed in.
	it('returns a new array, not the input reference', () => {
		const input = [result('a', 0.9)];
		const kept = filterByMinScore(input, 0.5);
		expect(kept).not.toBe(input);
		expect(kept.map((r) => r.chunk.id)).toEqual(['a']);
	});
});
