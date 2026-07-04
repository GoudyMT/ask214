/**
 * Hybrid fusion of dense cosine + lexical BM25 into one ranked, filtered result list. Pure; operates on the
 * two score arrays (aligned to the corpus chunk order). Two jobs:
 *   - RANKING: score = alpha * cosine + (1 - alpha) * (bm25 normalized to the query's own max).
 *   - CORRECT-EMPTY: a lexical-grounding gate - a chunk is eligible only if it shares real query terms
 *     (bm25 >= minBm25). An off-corpus query has bm25 0 everywhere, so nothing is eligible -> empty.
 * alpha, minScore, minBm25 are tuned on the eval's TUNE split; the gate is reported on the HELD-OUT split.
 */

export type HybridParams = { alpha: number; minScore: number; minBm25: number };
export type HybridHit = { index: number; score: number };

export function fuseHybrid(
	cosine: number[],
	bm25: number[],
	k: number,
	params: HybridParams
): HybridHit[] {
	const maxBm25 = bm25.reduce((m, v) => Math.max(m, v), 0);
	const hits: HybridHit[] = [];
	for (let i = 0; i < cosine.length; i++) {
		const b = bm25[i] ?? 0;
		if (b < params.minBm25) continue; // lexical grounding: must share a real query term
		const bm25Norm = maxBm25 > 0 ? b / maxBm25 : 0;
		const score = params.alpha * (cosine[i] ?? 0) + (1 - params.alpha) * bm25Norm;
		if (score < params.minScore) continue;
		hits.push({ index: i, score });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, k);
}
