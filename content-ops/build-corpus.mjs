// Run from the repo root: `pnpm embed`. Build-time producer (never ships to a device). Reads the per-source
// chunk arrays, embeds each chunk with the SAME q8 MiniLM the browser embeds queries with, and writes the
// versioned corpus artifact the runtime decoder reads. Downloads the model from HF on first run (build-time
// only; the runtime self-hosts the model). Confirm the transformers API against the installed version if the
// first run errors.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from '@huggingface/transformers';
import { buildCorpusArtifact } from '../src/lib/ask/corpus-artifact.ts';
import { decodeCorpus } from '../src/lib/corpus/index.ts';
import { computeContentRevision } from '../src/lib/content-ops/refresh/content-revision.ts';

const CHUNKS_DIR = 'content-ops/chunks';
const OUT_DIR = 'static/corpus';
const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const MODEL_ID = 'all-MiniLM-L6-v2'; // stamped into the manifest; must equal the runtime EMBED_MODEL_ID + decodeCorpus expectedModelId
const VERSION = '1.0';
const SIZE_BUDGET_BYTES = 300 * 1024 * 1024; // the on-device total corpus budget
const PER_FILE_CAP_BYTES = 25 * 1024 * 1024; // Cloudflare Workers Assets per-file asset cap

// Read + concatenate every per-source chunk array (each file is a JSON array of chunks). Sorted for a
// reproducible artifact: a stable chunk/embedding order across runs and machines.
const files = readdirSync(CHUNKS_DIR)
	.filter((f) => f.endsWith('.json'))
	.sort();
if (files.length === 0) throw new Error('E_EMBED_NO_CHUNKS');
const chunks = files.flatMap((f) => JSON.parse(readFileSync(join(CHUNKS_DIR, f), 'utf8')));
console.log(`[embed] ${files.length} sources -> ${chunks.length} chunks`);

// q8 (model_quantized.onnx) MUST match the browser worker's dtype so corpus + query vectors align.
const extractor = await pipeline('feature-extraction', MODEL_REPO, { dtype: 'q8' });
const vectors = [];
let done = 0;
for (const c of chunks) {
	const out = await extractor(c.text, { pooling: 'mean', normalize: true });
	vectors.push(Float32Array.from(out.data));
	if (++done % 200 === 0) console.log(`  embedded ${done}/${chunks.length}`);
}

// Content-revision stamp: a stable content fingerprint over the chunks. Preserve the buildDate when the
// content is byte-identical to the committed artifact (so re-embedding unchanged content does not churn
// corpus-v1.0.1.json); stamp today only on a real content change.
const { contentHash } = computeContentRevision(
	chunks.map((c) => ({ id: c.id, text: c.text })),
	''
);
const manifestPath = join(OUT_DIR, 'corpus-v1.0.1.json');
let buildDate = new Date().toISOString().slice(0, 10);
if (existsSync(manifestPath)) {
	const prev = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (prev.contentRevision?.contentHash === contentHash) buildDate = prev.contentRevision.buildDate;
}
const contentRevision = { buildDate, contentHash };
const { manifest, embeddingsBuffer } = buildCorpusArtifact(
	chunks,
	vectors,
	MODEL_ID,
	VERSION,
	contentRevision
);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'corpus-v1.0.1.json'), JSON.stringify(manifest));
writeFileSync(join(OUT_DIR, 'corpus-v1.0.1.embeddings.bin'), Buffer.from(embeddingsBuffer));

const jsonBytes = statSync(join(OUT_DIR, 'corpus-v1.0.1.json')).size;
const binBytes = statSync(join(OUT_DIR, 'corpus-v1.0.1.embeddings.bin')).size;
const total = jsonBytes + binBytes;
console.log(
	`[embed] wrote ${chunks.length} chunks, dim ${manifest.dim}; json ${(jsonBytes / 1e6).toFixed(1)}MB + bin ${(binBytes / 1e6).toFixed(1)}MB = ${(total / 1e6).toFixed(1)}MB`
);
if (total > SIZE_BUDGET_BYTES) {
	console.error('[FAIL] corpus artifact exceeds the total corpus size budget');
	process.exit(1);
}
if (jsonBytes > PER_FILE_CAP_BYTES || binBytes > PER_FILE_CAP_BYTES) {
	console.error('[FAIL] a corpus file exceeds the per-file asset cap');
	process.exit(1);
}
// Self-verify: re-read the just-written artifact and decode it with the SAME model id the runtime expects,
// so a stale or model-mismatched artifact can never sit on disk unnoticed (E_CORPUS_MODEL is the gate the
// dim check cannot catch - MiniLM and arctic are both 384-dim).
const checkManifest = JSON.parse(readFileSync(join(OUT_DIR, 'corpus-v1.0.1.json'), 'utf8'));
const checkBuf = readFileSync(join(OUT_DIR, 'corpus-v1.0.1.embeddings.bin'));
const checkAb = checkBuf.buffer.slice(
	checkBuf.byteOffset,
	checkBuf.byteOffset + checkBuf.byteLength
);
const check = decodeCorpus(checkManifest, checkAb, MODEL_ID);
console.log(
	`[verify] decoded OK: modelId "${checkManifest.modelId}", dim ${check.dim}, ${check.chunks.length} chunks`
);
console.log('[ok] wrote static/corpus/corpus-v1.0.*');
