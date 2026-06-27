// Run from the repo root: `npx tsx content-ops/run-eval.mjs` (after the embed script has written the
// artifact). Loads the shipped corpus, embeds each eval query with MiniLM, ranks chunks via B.search,
// and reports recall@5 + MRR (+ per-query hits) against the acceptance gate.
import { readFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';
import { decodeCorpus, search } from '../src/lib/corpus/index.ts';
import { recallAtK, meanReciprocalRank } from '../src/lib/ask/eval/metrics.ts';

const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const MODEL_ID = 'all-MiniLM-L6-v2';
const K = 5;
// The store's retrieval cutoff (src/lib/ask/store.svelte.ts). Mirrored here (out-of-band script) so the
// re-gate check below catches when corpus growth compresses scores enough to need recalibration.
const MIN_SCORE = 0.4;

const manifest = JSON.parse(readFileSync('static/corpus/corpus-v1.0.json', 'utf8'));
const buf = readFileSync('static/corpus/corpus-v1.0.embeddings.bin');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const corpus = decodeCorpus(manifest, ab, MODEL_ID);
const queries = JSON.parse(readFileSync('src/lib/ask/eval/queries.json', 'utf8'));

if (corpus.chunks.length < 50) {
	console.warn(
		`[WARN] corpus is small (${corpus.chunks.length} chunks) - recall@5 is near-automatic at this size; recall@5, MRR, and MIN_SCORE MUST be recalibrated as the corpus scales.`
	);
}

// q8 to match the corpus embed + the browser worker - same precision -> comparable vectors.
const extractor = await pipeline('feature-extraction', MODEL_REPO, { dtype: 'q8' });
const ranked = [];
const scored = []; // full RetrievalResult[] per query (id + score) for the MIN_SCORE calibration dump
for (const q of queries) {
	const out = await extractor(q.query, { pooling: 'mean', normalize: true });
	const results = search(Float32Array.from(out.data), corpus, K);
	ranked.push(results.map((r) => r.chunk.id));
	scored.push(results);
}

const expected = queries.map((q) => q.expectedChunkIds);
const r5 = recallAtK(ranked, expected, K);
const mrr = meanReciprocalRank(ranked, expected);

queries.forEach((q, i) => {
	const top = ranked[i].slice(0, K);
	const hit = q.expectedChunkIds.some((id) => top.includes(id));
	console.log(`  [${hit ? 'HIT ' : 'MISS'}] "${q.query}" -> ${ranked[i][0]}`);
});
console.log(
	`\nrecall@${K}=${r5.toFixed(3)}  MRR=${mrr.toFixed(3)}  (gate: recall@5>=0.8, MRR>=0.6)`
);

// --- MIN_SCORE calibration: the store drops hits below a cosine cutoff. Pick it
// below the lowest RELEVANT (expected) score so no valid lead is dropped, ideally above the
// non-relevant tail so weak matches collapse. Prints the real per-query distribution to choose from.
const relevantScores = [];
const nonRelevantScores = [];
console.log(`\n[per-query top-${K} scores]  (* = expected/relevant chunk)`);
scored.forEach((results, i) => {
	const expectedIds = queries[i].expectedChunkIds;
	const line = results
		.map((r) => `${r.chunk.id}=${r.score.toFixed(3)}${expectedIds.includes(r.chunk.id) ? '*' : ''}`)
		.join('  ');
	console.log(`  "${queries[i].query}"\n    ${line}`);
	for (const r of results) {
		(expectedIds.includes(r.chunk.id) ? relevantScores : nonRelevantScores).push(r.score);
	}
});
const minRelevant = Math.min(...relevantScores);
console.log(`\n[MIN_SCORE calibration]  (MIN_SCORE = ${MIN_SCORE})`);
console.log(
	`  min relevant (expected) score : ${minRelevant.toFixed(3)}  <- MIN_SCORE must be BELOW this`
);
console.log(
	`  max non-relevant score        : ${Math.max(...nonRelevantScores).toFixed(3)}  <- noise ceiling`
);
console.log(
	`  min top-1 (weakest lead)      : ${Math.min(...scored.map((r) => r[0].score)).toFixed(3)}`
);

// Re-gate: MIN_SCORE must stay safely below the weakest valid (relevant) lead, or it starts dropping real
// answers. If the margin closes (corpus growth compresses scores), fail loudly -> recalibrate.
if (minRelevant <= MIN_SCORE + 0.05) {
	console.error(
		`[FAIL] weakest relevant score ${minRelevant.toFixed(3)} is within 0.05 of MIN_SCORE ${MIN_SCORE} - recalibrate the threshold.`
	);
	process.exit(1);
}

if (r5 < 0.8 || mrr < 0.6) {
	console.error(
		'[FAIL] below the acceptance gate - iterate on chunks/queries or swap to BGE-small'
	);
	process.exit(1);
}
console.log('[PASS] meets the acceptance gate');
