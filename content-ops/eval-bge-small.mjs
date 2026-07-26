// Floor-check spike: does bge-small-en-v1.5 clear the v1.0 ranking floor as the server-side (Context 2)
// embedding model? Mirrors run-eval.mjs but embeds BOTH the corpus and the queries in-memory with bge-small
// (full precision) rather than loading the shipped q8 all-MiniLM artifact. A PROXY for the Workers AI
// bge-small serving: same model weights, so a comfortable pass is strong evidence the server path holds the
// floor, and a fail here fails regardless of serving. Reports only - the all-MiniLM shipped MIN_SCORE (0.4)
// does not transfer to bge-small's cosine scale, so each variant self-calibrates on the TUNE split and is
// gated on HELD-OUT. Set SPIKE_LIMIT=N to embed only the first N chunks (a fast harness smoke; the floor
// number is meaningless on a truncated corpus).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from '@huggingface/transformers';
import { cosineSimilarity } from '../src/lib/corpus/index.ts';
import { resolveExpectedIds, isHardNegative } from '../src/lib/ask/eval/resolve-ground-truth.ts';
import { partitionEvalSet } from '../src/lib/ask/eval/split.ts';
import { evalUnderParams } from '../src/lib/ask/eval/tune.ts';

const CHUNKS_DIR = 'content-ops/chunks';
const MODEL_REPO = 'Xenova/bge-small-en-v1.5';
const K = 5;
const HELD_OUT_PCT = 30;
const FLOOR = { srcHitRate: 0.8, srcMRR: 0.6 };
const MINILM_BASELINE = 'all-MiniLM q8 (shipped on-device): held-out ~0.875/0.618';
const MIN_SCORE_CANDIDATES = [
	0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75
];
// bge retrieval convention: prefix the QUERY (not the passages) with an instruction. v1.5 made it optional,
// so test both variants - the server must know whether to replicate the prefix.
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const LIMIT = process.env.SPIKE_LIMIT ? Number(process.env.SPIKE_LIMIT) : Infinity;
/** @param {number} minScore */
const DENSE = (minScore) => ({ alpha: 1, minScore, minBm25: 0 });
/** @param {{ srcHitRate: number, srcMRR: number }} m */
const fmt = (m) => `srcHitRate@${K}=${m.srcHitRate.toFixed(3)}  srcMRR=${m.srcMRR.toFixed(3)}`;

const files = readdirSync(CHUNKS_DIR)
	.filter((f) => f.endsWith('.json'))
	.sort();
if (files.length === 0) throw new Error('E_EVAL_NO_CHUNKS');
let chunks = files.flatMap((f) => JSON.parse(readFileSync(join(CHUNKS_DIR, f), 'utf8')));
if (Number.isFinite(LIMIT)) chunks = chunks.slice(0, LIMIT);
const queries = JSON.parse(readFileSync('src/lib/ask/eval/queries.json', 'utf8'));
console.log(
	`[spike] ${files.length} sources -> ${chunks.length} chunks; ${queries.length} queries; model ${MODEL_REPO}`
);

const extractor = await pipeline('feature-extraction', MODEL_REPO, { dtype: 'fp32' });
/** @param {string} text */
const embed = async (text) => {
	const out = await extractor(text, { pooling: 'mean', normalize: true });
	return Float32Array.from(out.data);
};

console.log('[embed] corpus (passages, no prefix) ...');
/** @type {Float32Array[]} */
const embeddings = [];
let done = 0;
for (const c of chunks) {
	embeddings.push(await embed(c.text));
	if (++done % 200 === 0) console.log(`  ${done}/${chunks.length}`);
}

const chunkSourceIds = chunks.map((c) => c.sourceId);
const bySource = new Map();
for (const c of chunks) {
	const list = bySource.get(c.sourceId) ?? [];
	list.push(c);
	bySource.set(c.sourceId, list);
}
const ZEROS = chunks.map(() => 0);

// Ground-truth integrity (rung 1): every positive snippet must resolve to a chunk. Skipped under SPIKE_LIMIT
// (a truncated corpus legitimately drops snippets).
if (!Number.isFinite(LIMIT)) {
	for (const q of queries) {
		if (isHardNegative(q)) continue;
		if (resolveExpectedIds(q, bySource).length === 0) {
			console.error(`[FAIL] E_EVAL_SNIPPET_UNRESOLVED: "${q.query}" (source ${q.sourceId})`);
			process.exit(1);
		}
	}
}

const { tune } = partitionEvalSet(queries, HELD_OUT_PCT);
const tuneSet = new Set(tune.map((q) => q.query));

/** Build a per-query cosine cache for a given query-text transform. @param {(q: string) => string} transform */
async function buildCache(transform) {
	const cache = [];
	for (const q of queries) {
		const qVec = await embed(transform(q.query));
		cache.push({ item: q, cosine: embeddings.map((e) => cosineSimilarity(qVec, e)), bm25: ZEROS });
	}
	return cache;
}

/**
 * Calibrate the display cutoff on TUNE, then gate on HELD-OUT at both rank(0) and the calibrated cutoff.
 * @param {string} label
 * @param {Awaited<ReturnType<typeof buildCache>>} cache
 */
function evalVariant(label, cache) {
	const tuneCache = cache.filter((c) => tuneSet.has(c.item.query));
	const heldCache = cache.filter((c) => !tuneSet.has(c.item.query));
	let calibrated = 0;
	for (const ms of MIN_SCORE_CANDIDATES) {
		const t = evalUnderParams(tuneCache, chunkSourceIds, DENSE(ms), K);
		if (t.srcHitRate >= FLOOR.srcHitRate && t.srcMRR >= FLOOR.srcMRR) calibrated = ms;
	}
	const heldRank = evalUnderParams(heldCache, chunkSourceIds, DENSE(0), K);
	const heldCal = evalUnderParams(heldCache, chunkSourceIds, DENSE(calibrated), K);
	/** @param {ReturnType<typeof evalUnderParams>} m */
	const below = (m) => m.srcHitRate < FLOOR.srcHitRate || m.srcMRR < FLOOR.srcMRR;
	const pass = !below(heldRank) && !below(heldCal);
	console.log(`\n[${label}] calibrated MIN_SCORE ${calibrated.toFixed(2)}`);
	console.log(`  HELD-OUT @ rank(0)   ${fmt(heldRank)}`);
	console.log(
		`  HELD-OUT @ ${calibrated.toFixed(2)}     ${fmt(heldCal)}   ${pass ? 'PASS' : 'FAIL'}`
	);
	return pass;
}

console.log('[embed] queries WITH prefix ...');
const cacheP = await buildCache((q) => QUERY_PREFIX + q);
console.log('[embed] queries WITHOUT prefix ...');
const cacheN = await buildCache((q) => q);

const passP = evalVariant('bge-small, query-prefix', cacheP);
const passN = evalVariant('bge-small, no-prefix', cacheN);

console.log(`\n  floor ${FLOOR.srcHitRate}/${FLOOR.srcMRR}  |  ${MINILM_BASELINE}`);
const ok = passP || passN;
const which =
	passP && passN
		? 'both variants'
		: passP
			? 'prefix only'
			: passN
				? 'no-prefix only'
				: 'neither variant';
console.log(
	`\n[${ok ? 'PASS' : 'FAIL'}] bge-small ${ok ? 'CLEARS' : 'MISSES'} the v1.0 held-out floor (${which}). Architecture Y ${ok ? 'validated as a local proxy - confirm on the Workers AI serving next' : 'in question - reconsider (bge-base 768d / grow eval / retune)'}`
);
