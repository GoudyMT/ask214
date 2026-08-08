// Run from the repo root: `pnpm eval:bge` (with the bge-embed `wrangler dev` worker running).
// Floor-gates the SERVER bge index the retrieve Worker will load from KV. It decodes the PERSISTED artifact
// (so it scores exactly the vectors the Worker searches -- codec-normalized), embeds each eval query WITH the
// bge instruction prefix through the real Workers AI serving, and gates the held-out ranking floor at rank(0)
// AND at the Worker's shipped MIN_SCORE (0.6). Fail-closed; never lower the gate -- climb the escalation
// ladder. Mirrors run-eval.mjs's leakage-free tune/held-out split (calibration on TUNE, gate on HELD-OUT).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCorpus, cosineSimilarity } from '../src/lib/corpus/index.ts';
import { resolveExpectedIds, isHardNegative } from '../src/lib/ask/eval/resolve-ground-truth.ts';
import { partitionEvalSet } from '../src/lib/ask/eval/split.ts';
import { evalUnderParams } from '../src/lib/ask/eval/tune.ts';

const MODEL_ID = '@cf/baai/bge-small-en-v1.5';
const OUT_DIR = 'content-ops/server-index';
const K = 5;
const HELD_OUT_PCT = 30;
const FLOOR = { srcHitRate: 0.8, srcMRR: 0.6 };
// The retrieve Worker's fixed display cutoff (workers/retrieve/src/index.ts MIN_SCORE). The held-out floor is
// gated at THIS value + at rank(0), so the number that certifies the server is the cutoff that actually ships.
const WORKER_MIN_SCORE = 0.6;
const MIN_SCORE_CANDIDATES = [
	0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75
];
// bge asymmetry: the QUERY carries the instruction prefix; passages (indexed) do not. MUST match the retrieve
// Worker's QUERY_PREFIX and the prefix the index was built with.
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const EMBED_URL = process.env.BGE_EMBED_URL ?? 'http://127.0.0.1:8787';
/** @param {number} minScore */
const DENSE = (minScore) => ({ alpha: 1, minScore, minBm25: 0 });
/** @param {{ srcHitRate: number, srcMRR: number }} m */
const fmt = (m) => `srcHitRate@${K}=${m.srcHitRate.toFixed(3)}  srcMRR=${m.srcMRR.toFixed(3)}`;

const manifest = JSON.parse(readFileSync(join(OUT_DIR, 'corpus-v1.0.bge.json'), 'utf8'));
const buf = readFileSync(join(OUT_DIR, 'corpus-v1.0.bge.bin'));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const corpus = decodeCorpus(manifest, ab, MODEL_ID);
const queries = JSON.parse(readFileSync('src/lib/ask/eval/queries.json', 'utf8'));
console.log(
	`[eval:bge] ${corpus.chunks.length} chunks; ${queries.length} queries; model ${MODEL_ID}`
);

const chunkSourceIds = corpus.chunks.map((c) => c.sourceId);
const ZEROS = corpus.chunks.map(() => 0); // dense ignores BM25; evalUnderParams still takes the array
const bySource = new Map();
for (const c of corpus.chunks) {
	const list = bySource.get(c.sourceId) ?? [];
	list.push(c);
	bySource.set(c.sourceId, list);
}

// Ground-truth integrity (ladder rung 1): every positive snippet must resolve to at least one chunk.
for (const q of queries) {
	if (isHardNegative(q)) continue;
	if (resolveExpectedIds(q, bySource).length === 0) {
		console.error(`[FAIL] E_EVAL_SNIPPET_UNRESOLVED: "${q.query}" (source ${q.sourceId})`);
		process.exit(1);
	}
}

// Embed one query WITH the bge prefix through the real serving (via the build worker).
/** @param {string} text */
async function embed(text) {
	const res = await fetch(EMBED_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ texts: [text] })
	});
	if (!res.ok) throw new Error('E_EMBED_HTTP');
	const data = await res.json();
	const v = data?.vectors?.[0];
	if (!Array.isArray(v)) throw new Error('E_EMBED_SHAPE');
	return Float32Array.from(v);
}

// Cache per-query cosine over all chunks (embed the query once). BM25 is zero (v1.0 is pure dense).
const cache = [];
for (const q of queries) {
	const qVec = await embed(QUERY_PREFIX + q.query);
	const cosine = corpus.embeddings.map((emb) => cosineSimilarity(qVec, emb));
	cache.push({ item: q, cosine, bm25: ZEROS });
}

// Frozen split: partition by query-text hash (never influenced by calibration), then map to the cache.
const { tune } = partitionEvalSet(queries, HELD_OUT_PCT);
const tuneSet = new Set(tune.map((q) => q.query));
const tuneCache = cache.filter((c) => tuneSet.has(c.item.query));
const heldCache = cache.filter((c) => !tuneSet.has(c.item.query));
console.log(`[split] tune ${tuneCache.length}  held-out ${heldCache.length}`);

// Calibrated cutoff (highest holding the TUNE floor) is context only; the gate is rank(0) + the Worker's 0.6.
let calibrated = 0;
for (const ms of MIN_SCORE_CANDIDATES) {
	const t = evalUnderParams(tuneCache, chunkSourceIds, DENSE(ms), K);
	if (t.srcHitRate >= FLOOR.srcHitRate && t.srcMRR >= FLOOR.srcMRR) calibrated = ms;
}
const heldRank = evalUnderParams(heldCache, chunkSourceIds, DENSE(0), K);
const heldWorker = evalUnderParams(heldCache, chunkSourceIds, DENSE(WORKER_MIN_SCORE), K);
console.log(`\n[bge server index] calibrated cutoff (context) ${calibrated.toFixed(2)}`);
console.log(`  HELD-OUT @ rank(0)            ${fmt(heldRank)}`);
console.log(
	`  HELD-OUT @ MIN_SCORE ${WORKER_MIN_SCORE}    ${fmt(heldWorker)}   <- the shipped-cutoff gate`
);
console.log(`  floor ${FLOOR.srcHitRate}/${FLOOR.srcMRR}`);
// Held-out floor across candidate cutoffs -- the highest that still holds is the calibrated MIN_SCORE.
console.log('  [held-out sweep]');
for (const ms of [0.5, 0.55, 0.6, 0.62, 0.65]) {
	const m = evalUnderParams(heldCache, chunkSourceIds, DENSE(ms), K);
	const holds = m.srcHitRate >= FLOOR.srcHitRate && m.srcMRR >= FLOOR.srcMRR;
	console.log(`    @ ${ms.toFixed(2)}  ${fmt(m)}  ${holds ? 'holds' : 'below'}`);
}

// Gate (fail-closed) on the held-out floor at BOTH rank(0) and the Worker's shipped MIN_SCORE.
/** @param {ReturnType<typeof evalUnderParams>} m */
const belowFloor = (m) => m.srcHitRate < FLOOR.srcHitRate || m.srcMRR < FLOOR.srcMRR;
if (belowFloor(heldRank) || belowFloor(heldWorker)) {
	console.error(
		`\n[FAIL] bge server index below the v1.0 floor (rank ${fmt(heldRank)}; @${WORKER_MIN_SCORE} ${fmt(heldWorker)}) -- never lower the gate, climb the escalation ladder`
	);
	process.exit(1);
}
console.log(
	`\n[PASS] bge server index clears the v1.0 held-out floor at rank(0) and MIN_SCORE ${WORKER_MIN_SCORE}`
);
