import type { EvalQuery } from './resolve-ground-truth';

/**
 * Deterministic djb2 hash of the query text folded to a 0..99 bucket. A pure function of the string alone,
 * so a query's bucket never changes with the rest of the set - the property the frozen tune/held-out split
 * relies on to stay leakage-free across runs.
 */
export function evalBucket(query: string): number {
	let h = 5381;
	for (let i = 0; i < query.length; i++) {
		h = ((h << 5) + h + query.charCodeAt(i)) >>> 0; // h * 33 + c, kept unsigned 32-bit
	}
	return h % 100;
}

/**
 * Partition an eval set into a TUNE split (hyperparameters are fit here) and a frozen HELD-OUT split (the
 * acceptance gate is reported here). heldOut = the queries whose bucket is below heldOutPct. Frozen by
 * construction: membership depends only on the query text, never on tuning, so the held-out gate is an
 * honest estimate of unseen performance (no train-on-test leakage).
 */
export function partitionEvalSet(
	queries: EvalQuery[],
	heldOutPct = 30
): { tune: EvalQuery[]; heldOut: EvalQuery[] } {
	const tune: EvalQuery[] = [];
	const heldOut: EvalQuery[] = [];
	for (const q of queries) {
		if (evalBucket(q.query) < heldOutPct) heldOut.push(q);
		else tune.push(q);
	}
	return { tune, heldOut };
}
