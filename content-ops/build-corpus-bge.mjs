// Run from the repo root: `pnpm embed:bge` (with the bge-embed `wrangler dev` worker running). The
// SERVER-side twin of build-corpus.mjs: reads the same per-source chunk arrays, embeds each chunk (as a
// passage, NO prefix) through the REAL Workers AI bge-small serving via the local build worker, and writes
// the server corpus index the retrieve Worker loads from KV. Not shipped to the device -- the client uses the
// MiniLM index in static/. One chunk set, two indexes, same corpusVersion. The manifest + blob are
// the exact decode contract `decodeCorpus` (and the retrieve Worker) expect.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildCorpusArtifact } from '../src/lib/ask/corpus-artifact.ts';
import { decodeCorpus } from '../src/lib/corpus/index.ts';
import { computeContentRevision } from '../src/lib/content-ops/refresh/content-revision.ts';

const CHUNKS_DIR = 'content-ops/chunks';
const OUT_DIR = 'content-ops/server-index';
const MANIFEST_PATH = join(OUT_DIR, 'corpus-v1.0.bge.json');
const EMBEDDINGS_PATH = join(OUT_DIR, 'corpus-v1.0.bge.bin');
// Stamped into the manifest; MUST equal the retrieve Worker's BGE_MODEL_ID + decodeCorpus expectedModelId.
const MODEL_ID = '@cf/baai/bge-small-en-v1.5';
const VERSION = '1.0';
const EXPECTED_DIM = 384; // bge-small-en-v1.5
const EMBED_URL = process.env.BGE_EMBED_URL ?? 'http://127.0.0.1:8787';
// Batch size per Workers AI embed call. Kept modest so one request stays well under the serving's batch cap.
const BATCH = process.env.BGE_BATCH ? Number(process.env.BGE_BATCH) : 96;

// Read + concatenate every per-source chunk array (each file is a JSON array of chunks). Sorted for a
// reproducible artifact: a stable chunk/embedding order across runs and machines. Same chunk set as MiniLM.
const files = readdirSync(CHUNKS_DIR)
	.filter((f) => f.endsWith('.json'))
	.sort();
if (files.length === 0) throw new Error('E_EMBED_NO_CHUNKS');
const chunks = files.flatMap((f) => JSON.parse(readFileSync(join(CHUNKS_DIR, f), 'utf8')));
console.log(`[bge] ${files.length} sources -> ${chunks.length} chunks`);

// Content-revision stamp over the chunks (the same fingerprint the MiniLM build uses). If the committed bge
// index already matches this content, skip the re-embed entirely -- no wrangler needed, no artifact churn.
const { contentHash } = computeContentRevision(
	chunks.map((c) => ({ id: c.id, text: c.text })),
	''
);
const prev = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : null;
if (prev?.contentRevision?.contentHash === contentHash) {
	console.log('[bge] committed index already matches the current chunks; nothing to embed.');
	process.exit(0);
}

// Embed passages through the Workers AI serving (via the local build worker). Passages carry NO prefix (bge
// asymmetry: only the query gets the instruction prefix -- matches the retrieve Worker + the eval).
/** @param {string[]} texts */
async function embedBatch(texts) {
	const res = await fetch(EMBED_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ texts })
	});
	if (!res.ok) throw new Error('E_EMBED_HTTP'); // opaque; build-time only, never user-facing
	const data = await res.json();
	const vectors = data?.vectors;
	if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error('E_EMBED_SHAPE');
	return vectors;
}

/** @type {Float32Array[]} */
const vectors = [];
for (let i = 0; i < chunks.length; i += BATCH) {
	const batch = chunks.slice(i, i + BATCH).map((c) => c.text);
	const embedded = await embedBatch(batch);
	for (const v of embedded) vectors.push(Float32Array.from(v));
	console.log(`  embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
}

// We only reach here on a real content change (or first build): stamp today.
const contentRevision = { buildDate: new Date().toISOString().slice(0, 10), contentHash };
const { manifest, embeddingsBuffer } = buildCorpusArtifact(
	chunks,
	vectors,
	MODEL_ID,
	VERSION,
	contentRevision
);
if (manifest.dim !== EXPECTED_DIM) throw new Error('E_EMBED_DIM');

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));
writeFileSync(EMBEDDINGS_PATH, Buffer.from(embeddingsBuffer));

const jsonBytes = statSync(MANIFEST_PATH).size;
const binBytes = statSync(EMBEDDINGS_PATH).size;
console.log(
	`[bge] wrote ${chunks.length} chunks, dim ${manifest.dim}; json ${(jsonBytes / 1e6).toFixed(1)}MB + bin ${(binBytes / 1e6).toFixed(1)}MB`
);

// Self-verify: re-read + decode with the SAME model id the retrieve Worker expects, so a stale or
// model-mismatched artifact can never sit on disk unnoticed (the dim check alone cannot catch a model swap).
const checkManifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const checkBuf = readFileSync(EMBEDDINGS_PATH);
const checkAb = checkBuf.buffer.slice(
	checkBuf.byteOffset,
	checkBuf.byteOffset + checkBuf.byteLength
);
const check = decodeCorpus(checkManifest, checkAb, MODEL_ID);
console.log(
	`[verify] decoded OK: modelId "${checkManifest.modelId}", dim ${check.dim}, ${check.chunks.length} chunks`
);
console.log('[ok] wrote content-ops/server-index/corpus-v1.0.bge.*');
