/**
 * Retrieval-quality metrics for the Ask acceptance gate. Pure: operate on
 * already-ranked chunk-id lists (best first) + the expected relevant ids per query. No model here.
 */

/** Fraction of queries where at least one expected id appears in the top-k ranked ids. */
export function recallAtK(ranked: string[][], expected: string[][], k: number): number {
	if (ranked.length === 0) return 0;
	let hits = 0;
	for (let i = 0; i < ranked.length; i++) {
		const top = (ranked[i] ?? []).slice(0, k);
		const want = expected[i] ?? [];
		if (want.some((id) => top.includes(id))) hits++;
	}
	return hits / ranked.length;
}

/** Honest alias of recallAtK: "hit-rate @ k" - the fraction of queries with >=1 expected id in the top-k. */
export const hitRateAtK = recallAtK;

/** Mean of 1/(rank of the first expected id); a query with no expected id in the list contributes 0. */
export function meanReciprocalRank(ranked: string[][], expected: string[][]): number {
	if (ranked.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < ranked.length; i++) {
		const list = ranked[i] ?? [];
		const want = expected[i] ?? [];
		const rank = list.findIndex((id) => want.includes(id)); // 0-based, -1 if absent
		if (rank !== -1) sum += 1 / (rank + 1);
	}
	return sum / ranked.length;
}
