// Rung-1 eval audit (read-only diagnostic; not shipped). For each positive whose PINNED source is not in the
// dense top-5, dump the query, the pinned source + snippet, and the dense top-5 (source : score : chunk-text
// head) so a miss can be classified: eval-item artifact (a retrieved source ALSO validly answers -> allow a
// valid-source SET), lexical/form-number (BM25's job), or a genuine retrieval miss.
//
// Run: pnpm exec tsx content-ops/audit-misses.mjs  (the standing miss-audit tool; re-run after a corpus or
// query change to re-classify misses - it produced the altSources multi-valid-source finding).
import { readFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';
import { decodeCorpus, cosineSimilarity } from '../src/lib/corpus/index.ts';
import { isHardNegative } from '../src/lib/ask/eval/resolve-ground-truth.ts';

const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const MODEL_ID = 'all-MiniLM-L6-v2';
const K = 5;

const manifest = JSON.parse(readFileSync('static/corpus/corpus-v1.0.json', 'utf8'));
const bin = readFileSync('static/corpus/corpus-v1.0.embeddings.bin');
const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const corpus = decodeCorpus(manifest, ab, MODEL_ID);
const allQueries =
	/** @type {import('../src/lib/ask/eval/resolve-ground-truth.ts').EvalQuery[]} */ (
		JSON.parse(readFileSync('src/lib/ask/eval/queries.json', 'utf8'))
	);
// After dropping hard-negatives, the rest are ground-truth positives (they carry sourceId + answerSnippet).
const positives =
	/** @type {import('../src/lib/ask/eval/resolve-ground-truth.ts').GroundTruthQuery[]} */ (
		allQueries.filter((q) => !isHardNegative(q))
	);

const extractor = await pipeline('feature-extraction', MODEL_REPO, { dtype: 'q8' });
/** @param {string} t */
const embed = async (t) =>
	Float32Array.from((await extractor(t, { pooling: 'mean', normalize: true })).data);
/** @param {string} s @param {number} n */
const head = (s, n) => s.replace(/\s+/g, ' ').trim().slice(0, n);

let misses = 0;
for (const q of positives) {
	const qv = await embed(q.query);
	const scored = [];
	for (let i = 0; i < corpus.chunks.length; i++) {
		const emb = corpus.embeddings[i];
		const c = corpus.chunks[i];
		if (!emb || !c) continue;
		scored.push({ c, score: cosineSimilarity(qv, emb) });
	}
	scored.sort((a, b) => b.score - a.score);
	const top = scored.slice(0, K);
	if (top.some((r) => r.c.sourceId === q.sourceId)) continue; // pinned source is in top-5 -> not a miss
	misses++;
	const rank = scored.findIndex((r) => r.c.sourceId === q.sourceId) + 1;
	console.log(`\n[MISS] "${q.query}"`);
	console.log(`   want ${q.sourceId} (rank ${rank})  snippet: "${head(q.answerSnippet, 80)}"`);
	top.forEach((r, i) =>
		console.log(`   top${i + 1} ${r.c.sourceId}=${r.score.toFixed(3)}  "${head(r.c.text, 110)}"`)
	);
}
console.log(
	`\n${misses} misses (pinned source not in dense top-${K}) of ${positives.length} positives`
);
