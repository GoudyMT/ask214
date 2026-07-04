import { fuseHybrid, type HybridParams } from '../../corpus/hybrid';
import { hitRateAtK, meanReciprocalRank } from './metrics';
import { isHardNegative, type EvalQuery } from './resolve-ground-truth';

/** A query with its per-chunk dense (cosine) and lexical (bm25) scores, aligned to the corpus chunk order. */
export type CachedQuery = { item: EvalQuery; cosine: number[]; bm25: number[] };

/** Source-level retrieval metrics under one hybrid parameter set. */
export type EvalMetrics = { srcHitRate: number; srcMRR: number; correctEmpty: number };

/**
 * Score an eval set under one hybrid parameter set. Positives contribute SOURCE-level hitRate + MRR (did
 * fuseHybrid rank the right document into the top-k); hard-negatives contribute correct-empty (fuseHybrid
 * returns nothing). Pure: no model, no I/O - it consumes the cached cosine/bm25 arrays, so the grid search
 * can score thousands of parameter combos without re-embedding.
 */
export function evalUnderParams(
	cached: CachedQuery[],
	chunkSourceIds: string[],
	params: HybridParams,
	k: number
): EvalMetrics {
	const rankedSources: string[][] = [];
	const expectedSources: string[][] = [];
	let negCount = 0;
	let correct = 0;
	for (const { item, cosine, bm25 } of cached) {
		const hits = fuseHybrid(cosine, bm25, k, params);
		if (isHardNegative(item)) {
			negCount++;
			if (hits.length === 0) correct++;
		} else {
			// index is a valid corpus position by construction; ?? '' satisfies noUncheckedIndexedAccess
			// (an impossible miss cannot match a real sourceId, so it is a harmless total-function guard).
			rankedSources.push(hits.map((h) => chunkSourceIds[h.index] ?? ''));
			// A hit = the primary source OR any altSource (the corpus has genuine content overlap; several
			// official sources validly answer the same question). altSources are source-level only.
			expectedSources.push([item.sourceId, ...(item.altSources ?? [])]);
		}
	}
	return {
		srcHitRate: hitRateAtK(rankedSources, expectedSources, k),
		srcMRR: meanReciprocalRank(rankedSources, expectedSources),
		correctEmpty: negCount === 0 ? 1 : correct / negCount
	};
}

/**
 * Coarse minBm25 candidates for the grid search, derived from the observed per-query BM25 scale (not
 * guessed): 0 (no lexical gate) plus the 25/50/75th percentiles of `values`, deduped ascending. Spanning
 * the real distribution lets the search trade correct-empty (a higher gate) against positive recall (lower).
 */
export function deriveMinBm25Candidates(values: number[]): number[] {
	if (values.length === 0) return [0];
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.floor((p / 100) * (sorted.length - 1))] ?? 0;
	return [...new Set([0, at(25), at(50), at(75)])].sort((a, b) => a - b);
}

/** The hyperparameter search space: every (alpha, minBm25, minScore) combination is scored on the set. */
export type Grid = { alpha: number[]; minBm25: number[]; minScore: number[] };

/**
 * Grid-search the hybrid parameters over `grid`, returning the combo that maximizes RANKING
 * (srcHitRate + srcMRR) on `cached` - the v1.0 acceptance metric. correct-empty is reported but NOT tuned
 * for (it moved to v1.1; a topically-adjacent hard-negative scores like a real answer, so no client-side
 * threshold separates them). Ties resolve to the first-encountered combo (stable alpha -> minBm25 ->
 * minScore order), so the result is deterministic. Run on the TUNE split only; report on the frozen
 * HELD-OUT split (no train-on-test leakage).
 */
export function gridSearch(
	cached: CachedQuery[],
	chunkSourceIds: string[],
	grid: Grid,
	k: number
): { params: HybridParams; metrics: EvalMetrics } {
	let best: { params: HybridParams; metrics: EvalMetrics; obj: number } | undefined;
	for (const alpha of grid.alpha) {
		for (const minBm25 of grid.minBm25) {
			for (const minScore of grid.minScore) {
				const params: HybridParams = { alpha, minScore, minBm25 };
				const metrics = evalUnderParams(cached, chunkSourceIds, params, k);
				const obj = metrics.srcHitRate + metrics.srcMRR; // v1.0 ranking objective; correct-empty is v1.1, not tuned
				if (best === undefined || obj > best.obj) best = { params, metrics, obj };
			}
		}
	}
	if (best === undefined) throw new Error('E_EVAL_EMPTY_GRID');
	return { params: best.params, metrics: best.metrics };
}
