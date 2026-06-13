// Run from the repo root: `npx tsx content-ops/embed-sample-corpus.mjs` (downloads MiniLM on first run).
// Embeds the sample chunks with the SAME model the browser embeds queries with, then writes the
// artifact B.decodeCorpus reads. Transformers.js v3 (@huggingface/transformers). Confirm the pipeline
// API against the huggingface-skills:transformers-js skill if the first run errors.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';
import { buildCorpusArtifact } from '../src/lib/ask/corpus-artifact.ts';

const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const MODEL_ID = 'all-MiniLM-L6-v2'; // stamped into the manifest; must equal src/lib/ask EMBED_MODEL_ID
const VERSION = '1.0';

const chunks = JSON.parse(readFileSync('content/sample-corpus/chunks.json', 'utf8'));
// q8 (model_quantized.onnx, ~23MB) - MUST match the browser worker's dtype so corpus + query vectors
// align. fp32 (~86MB) busts the ~25MB per-file cap and is hostile to a C1 mobile install (ADR-014/015).
const extractor = await pipeline('feature-extraction', MODEL_REPO, { dtype: 'q8' });

const vectors = [];
for (const c of chunks) {
	const out = await extractor(c.text, { pooling: 'mean', normalize: true });
	vectors.push(Float32Array.from(out.data));
}

const { manifest, embeddingsBuffer } = buildCorpusArtifact(chunks, vectors, MODEL_ID, VERSION);
mkdirSync('static/corpus', { recursive: true });
writeFileSync('static/corpus/corpus-v1.0.json', JSON.stringify(manifest));
writeFileSync('static/corpus/corpus-v1.0.embeddings.bin', Buffer.from(embeddingsBuffer));
console.log(`[ok] wrote ${chunks.length} chunks, dim ${manifest.dim} -> static/corpus/corpus-v1.0.*`);
