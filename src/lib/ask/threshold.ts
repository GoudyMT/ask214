import type { RetrievalResult } from '$lib/corpus';

/**
 * Keep only retrieval results that clear a minimum score.
 *
 * Contract:
 * - Returns a NEW array; the input is never mutated (pure, deterministic).
 * - Boundary is INCLUSIVE: a result whose `score` exactly equals `minScore` is kept (`>=`, not `>`).
 * - Surviving results stay in the SAME relative order as the input.
 *
 * @param results - Scored hits (`score` is a cosine similarity in [-1, 1]).
 * @param minScore - The inclusive lower bound a result's `score` must meet to survive.
 * @returns A new array of the results with `score >= minScore`, in input order.
 */
export function filterByMinScore(results: RetrievalResult[], minScore: number): RetrievalResult[] {
	return results.filter((r) => r.score >= minScore);
}
