// Run from the repo root: `pnpm eval` (after `pnpm embed`). Loads the shipped corpus, embeds each eval query
// with q8 MiniLM, and scores PURE DENSE retrieval (cosine top-k) - what v1.0 ships. Reports SOURCE-level
// hitRate + MRR (the primary signal: did top-k find the right document); v1.0 GATES on ranking only, on a
// frozen HELD-OUT split (no train-on-test leakage). Also calibrates the store's display MIN_SCORE: the
// highest cutoff that still holds the held-out ranking floor (hides weak results without dropping real
// answers - see corpus-calibration.test.ts). Fail-closed; never lower the gate - climb the escalation ladder.
//
// The hybrid experiment (src/lib/corpus/bm25.ts + hybrid.ts + the tune gridSearch) is retained + tested as
// the v1.1 lever (form-number queries + the correct-empty guarantee, which no client-side threshold can
// deliver - the A4 charter Measured Result); it is intentionally NOT used here because v1.0 ships dense.
// Pure logic lives in the tested units under src/lib/**; this file only injects the real model + orchestrates.
//
// NOTE (A4 sweep M1/L4): the held-out split is small (~15 positives), so the ranking floor is a knife-edge -
// 0.800 is exactly 12/15, and the MIN_SCORE calibration is flat across 0-0.4 (no held-out lead near the 0.4
// cutoff). If a future A5 refresh marginally misses, GROW the eval set (more positives per source, incl. a
// deliberately weak-scoring lead near the cutoff) BEFORE touching the model/thresholds - a one-query swing is
// sample noise, not a retrieval regression. See docs/sweeps/2026-07-04-content-ops-a4.md.
import { readFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';
import { decodeCorpus, cosineSimilarity } from '../src/lib/corpus/index.ts';
import { fuseHybrid } from '../src/lib/corpus/hybrid.ts';
import { hitRateAtK } from '../src/lib/ask/eval/metrics.ts';
import { resolveExpectedIds, isHardNegative } from '../src/lib/ask/eval/resolve-ground-truth.ts';
import { partitionEvalSet } from '../src/lib/ask/eval/split.ts';
import { evalUnderParams } from '../src/lib/ask/eval/tune.ts';

const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const MODEL_ID = 'all-MiniLM-L6-v2';
const K = 5;
const HELD_OUT_PCT = 30;
// v1.0 SOURCE-level ranking floor/target. correct-empty is reported but v1.1-gated (charter Measured Result).
const FLOOR = { srcHitRate: 0.8, srcMRR: 0.6 };
const TARGET = { srcHitRate: 0.9, srcMRR: 0.75 };
// MIN_SCORE candidates (display cutoff): pick the HIGHEST that still holds the held-out floor.
const MIN_SCORE_CANDIDATES = [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4];
// v1.0 retrieval = pure dense (alpha 1, no BM25 gate); minScore is the only knob (the display cutoff).
const DENSE = (minScore) => ({ alpha: 1, minScore, minBm25: 0 });

const manifest = JSON.parse(readFileSync('static/corpus/corpus-v1.0.json', 'utf8'));
const buf = readFileSync('static/corpus/corpus-v1.0.embeddings.bin');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const corpus = decodeCorpus(manifest, ab, MODEL_ID);
const queries = JSON.parse(readFileSync('src/lib/ask/eval/queries.json', 'utf8'));

const chunkSourceIds = corpus.chunks.map((c) => c.sourceId);
const ZEROS = corpus.chunks.map(() => 0); // dense ignores BM25; evalUnderParams/fuseHybrid still take the array
const bySource = new Map();
for (const c of corpus.chunks) {
	const list = bySource.get(c.sourceId) ?? [];
	list.push(c);
	bySource.set(c.sourceId, list);
}

const extractor = await pipeline('feature-extraction', MODEL_REPO, { dtype: 'q8' });
const embed = async (text) => {
	const out = await extractor(text, { pooling: 'mean', normalize: true });
	return Float32Array.from(out.data);
};

// --- Ground-truth integrity: every positive snippet MUST resolve to at least one chunk (ladder rung 1).
for (const q of queries) {
	if (isHardNegative(q)) continue;
	if (resolveExpectedIds(q, bySource).length === 0) {
		console.log(`  unresolved: "${q.query}" (source ${q.sourceId})`);
		console.error(
			'[FAIL] E_EVAL_SNIPPET_UNRESOLVED: a positive snippet matched no chunk - fix the snippet'
		);
		process.exit(1);
	}
}

// --- Cache per-query cosine over all chunks (embed once). BM25 is zero (v1.0 is dense).
const cache = [];
for (const q of queries) {
	const qVec = await embed(q.query);
	const cosine = corpus.embeddings.map((emb) => cosineSimilarity(qVec, emb));
	cache.push({ item: q, cosine, bm25: ZEROS });
}

// --- Frozen split: partition by query-text hash (never influenced by calibration), then map to the cache.
const { tune } = partitionEvalSet(queries, HELD_OUT_PCT);
const tuneSet = new Set(tune.map((q) => q.query));
const tuneCache = cache.filter((c) => tuneSet.has(c.item.query));
const heldCache = cache.filter((c) => !tuneSet.has(c.item.query));
const nPos = (list) => list.filter((c) => !isHardNegative(c.item)).length;
const nNeg = (list) => list.filter((c) => isHardNegative(c.item)).length;
console.log(
	`[split] tune ${tuneCache.length} (${nPos(tuneCache)}pos/${nNeg(tuneCache)}neg)  held-out ${heldCache.length} (${nPos(heldCache)}pos/${nNeg(heldCache)}neg)`
);

// --- MIN_SCORE calibration: the HIGHEST display cutoff that still holds the ranking floor, SELECTED on the
// TUNE split (never the held-out set - the gate below must stay a leakage-free unseen-data estimate). Since
// minScore is a monotone display cutoff (a higher cutoff only drops results, never adds a hit), this picks
// the max cutoff that does not erode tune ranking; the held-out gate then re-tests at that fixed value.
console.log('\n[MIN_SCORE calibration - dense, TUNE split (gated on held-out below)]');
let calibrated = 0;
for (const ms of MIN_SCORE_CANDIDATES) {
	const t = evalUnderParams(tuneCache, chunkSourceIds, DENSE(ms), K);
	const pass = t.srcHitRate >= FLOOR.srcHitRate && t.srcMRR >= FLOOR.srcMRR;
	console.log(
		`  minScore ${ms.toFixed(2)}  tune srcHitRate=${t.srcHitRate.toFixed(3)} srcMRR=${t.srcMRR.toFixed(3)}  ${pass ? 'PASS' : 'fail'}`
	);
	if (pass) calibrated = ms;
}
console.log(
	`[calibrated MIN_SCORE] ${calibrated.toFixed(2)}  (highest cutoff holding the TUNE floor; gated on held-out)`
);
const params = DENSE(calibrated);

// --- Report at the calibrated MIN_SCORE. HELD-OUT is the honest gate; TUNE + FULL are context.
const tuneM = evalUnderParams(tuneCache, chunkSourceIds, params, K);
const heldM = evalUnderParams(heldCache, chunkSourceIds, params, K);
const fullM = evalUnderParams(cache, chunkSourceIds, params, K);
const fmt = (m) => `srcHitRate@${K}=${m.srcHitRate.toFixed(3)}  srcMRR=${m.srcMRR.toFixed(3)}`;
console.log(`\n[dense @ MIN_SCORE ${calibrated.toFixed(2)}]`);
console.log(`  TUNE      ${fmt(tuneM)}`);
console.log(`  HELD-OUT  ${fmt(heldM)}   <- the acceptance gate`);
console.log(`  FULL      ${fmt(fullM)}`);
console.log(`  correct-empty (v1.1 metric, not gated at v1.0): ${fullM.correctEmpty.toFixed(3)}`);
console.log(
	`  floor ${FLOOR.srcHitRate}/${FLOOR.srcMRR}  target ${TARGET.srcHitRate}/${TARGET.srcMRR}`
);

// --- Per-query readout on the FULL set. [HIT] = the exact expected chunk in top-k; [SRC] = right source,
// different chunk; [MISS] = wrong source. Hard-negatives show what the best-effort store would surface.
const rankedChunkIdsAll = [];
const expectedChunkIdsAll = [];
console.log(`\n[per-query - full set]`);
for (const c of cache) {
	const hits = fuseHybrid(c.cosine, c.bm25, K, params);
	const rankedSources = hits.map((h) => chunkSourceIds[h.index] ?? '?');
	if (isHardNegative(c.item)) {
		const top = hits[0];
		console.log(
			`  [${top ? 'shows' : 'empty'}] (hard-neg) "${c.item.query}"${top ? ` -> ${chunkSourceIds[top.index] ?? '?'} (${top.score.toFixed(3)})` : ''}`
		);
	} else {
		const rankedChunkIds = hits.map((h) => corpus.chunks[h.index]?.id ?? '');
		const expectedChunkIds = resolveExpectedIds(c.item, bySource);
		rankedChunkIdsAll.push(rankedChunkIds);
		expectedChunkIdsAll.push(expectedChunkIds);
		const chunkHit = expectedChunkIds.some((id) => rankedChunkIds.slice(0, K).includes(id));
		const validSources = [c.item.sourceId, ...(c.item.altSources ?? [])];
		const srcHit = rankedSources.slice(0, K).some((s) => validSources.includes(s));
		const tag = chunkHit ? 'HIT ' : srcHit ? 'SRC ' : 'MISS';
		console.log(`  [${tag}] "${c.item.query}" -> ${rankedSources[0] ?? '(empty)'}`);
	}
}
const chunkHitRate = hitRateAtK(rankedChunkIdsAll, expectedChunkIdsAll, K);
console.log(`\n[chunk-level precision readout] chunkHitRate@${K}=${chunkHitRate.toFixed(3)}`);

// --- Gate (fail-closed) on the HELD-OUT ranking floor at the calibrated MIN_SCORE. Never lower the gate.
if (heldM.srcHitRate < FLOOR.srcHitRate || heldM.srcMRR < FLOOR.srcMRR) {
	console.error(
		'\n[FAIL] held-out ranking below the floor - climb the escalation ladder, never lower the gate'
	);
	process.exit(1);
}
console.log(
	`\n[PASS] held-out meets the v1.0 ranking floor at MIN_SCORE ${calibrated.toFixed(2)} (correct-empty is a v1.1 gate)`
);
