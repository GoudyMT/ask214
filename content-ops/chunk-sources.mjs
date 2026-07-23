// content-ops/chunk-sources.mjs
// Run from the repo root: `pnpm chunk` (optionally one or more source_ids to scope the run). Build-time
// chunker: reads the per-source CLEANED text (content-ops/cleaned/<id>.json, never the raw extraction
// directly), cuts it into ~256-token verbatim CorpusChunks with citation anchors, and writes chunks/<id>.json
// for the embed step. Never runs on a user device. Before chunking anything, a fail-closed gate checks every
// selected source's cleaned output is both derived from the CURRENT extraction and human-approved as that
// exact cleaned output (per content-ops/cleaned/manifest.json) - a cleaning-rules change re-opens the gate
// even though the extraction itself is untouched, since it changes the cleaned output's hash. The logic
// lives in the tested pure units under src/lib/content-ops/chunk/ + clean/clean-approval.ts; this script
// does the IO and loads the real WordPiece tokenizer (the same MiniLM the Ask embedder uses, so the token
// budget matches the model that embeds them).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { AutoTokenizer } from '@huggingface/transformers';
import { splitIntoSpans } from '../src/lib/content-ops/chunk/split.ts';
import { checkCoverage } from '../src/lib/content-ops/chunk/coverage.ts';
import { computeAnchor } from '../src/lib/content-ops/chunk/anchor.ts';
import { toChunk } from '../src/lib/content-ops/chunk/to-chunk.ts';
import { validateCorpusAgainstRegistry } from '../src/lib/content-ops/corpus-crossref.ts';
import { isCleanApproved } from '../src/lib/content-ops/clean/clean-approval.ts';

/** @typedef {import('../src/lib/content-ops/sources-schema.ts').SourceEntry} SourceEntry */
/** @typedef {import('../src/lib/content-ops/extract/pdf-text.ts').Block} Block */
/** @typedef {{ sourceId: string, contentHash: string, cleanedHash: string, decision: 'pending' | 'approved', dropped: number, stripped: number, review: number }} CleanedManifestSource */
/** @typedef {{ generatedAt: string, sources: CleanedManifestSource[] }} CleanedManifest */
/** @typedef {{ source_id: string, content_hash: string, blocks: Block[], normalizedText: string }} CleanedDoc */

const SOURCES_YAML = 'content/sources.yaml';
const EXTRACTED_DIR = 'content-ops/extracted';
const CLEANED_DIR = 'content-ops/cleaned';
const MANIFEST_PATH = join(CLEANED_DIR, 'manifest.json');
const CHUNKS_DIR = 'content-ops/chunks';
// The Ask embedder loads this same repo at dtype q8 (src/lib/ask/embed-worker.ts + embed-sample-corpus.mjs);
// its WordPiece tokenizer defines our budget so no chunk's tail is truncated out of its own vector.
const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const TARGET_TOKENS = 254; // the 256 model window minus the [CLS] + [SEP] specials the model adds
const TINY_TOKENS = 40; // chunks below this are surfaced (not failed) by the quality signal

/** SHA-256 hex of the cleaned-output fingerprint (normalizedText) - must match how clean-sources.mjs
 *  computes cleanedHash, since the gate below keys approval on this exact value.
 *  @param {string} s @returns {string} */
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const ARGS = process.argv.slice(2);
/** @param {string} id */
const pick = (id) => ARGS.length === 0 || ARGS.includes(id);

mkdirSync(CHUNKS_DIR, { recursive: true });
const registry = /** @type {SourceEntry[]} */ (parse(readFileSync(SOURCES_YAML, 'utf8')));
const byId = new Map(registry.map((e) => [e.source_id, e]));

const files = readdirSync(CLEANED_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
const picked = files.filter((f) => pick(f.replace(/\.json$/, '')));

console.log('='.repeat(60));
console.log('CONTENT-OPS - CHUNK + ANCHOR');
console.log('='.repeat(60));

// Fail-closed gate: nothing chunks until every selected source's cleaned output is both derived
// from the CURRENT extraction and human-approved as that EXACT cleaned output. Runs before the
// (slow, network-fetched) tokenizer loads and before any chunk is written, so a review gap fails
// fast with the working tree untouched.
const manifest = existsSync(MANIFEST_PATH)
	? /** @type {CleanedManifest} */ (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')))
	: /** @type {CleanedManifest} */ ({ generatedAt: '', sources: [] });
const manifestById = new Map(manifest.sources.map((s) => [s.sourceId, s]));

const failedGate = [];
for (const file of picked) {
	const sourceId = file.replace(/\.json$/, '');
	const cleaned = /** @type {CleanedDoc} */ (
		JSON.parse(readFileSync(join(CLEANED_DIR, file), 'utf8'))
	);
	const extractedPath = join(EXTRACTED_DIR, file);
	const currentExtractionHash = existsSync(extractedPath)
		? JSON.parse(readFileSync(extractedPath, 'utf8')).content_hash
		: '';
	const cleanedHash = sha256(cleaned.normalizedText);
	const approved = isCleanApproved(
		currentExtractionHash,
		{ extractionHash: cleaned.content_hash, cleanedHash },
		manifestById.get(sourceId)
	);
	if (!approved) failedGate.push(sourceId);
}
if (failedGate.length > 0) {
	console.error(
		`[FAIL] ${failedGate.length} source(s) need cleaning review: run pnpm run clean (then pnpm run clean --approve-all)`
	);
	for (const id of failedGate) console.error(`    ${id}`);
	process.exit(1);
}

// content tokens only (exclude the [CLS]/[SEP] specials); encode(...) returns the token-id array
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_REPO);
/** @param {string} text @returns {number} */
const countTokens = (text) => tokenizer.encode(text, { add_special_tokens: false }).length;

const allChunks = [];
/** @type {Record<string, string>} */
const extractions = {};
const flags = [];

for (const file of picked) {
	const sourceId = file.replace(/\.json$/, '');
	const entry = byId.get(sourceId);
	if (!entry) {
		console.error(`[FAIL] ${sourceId}: not in ${SOURCES_YAML}`);
		process.exit(1);
	}
	try {
		const cleaned = /** @type {CleanedDoc} */ (
			JSON.parse(readFileSync(join(CLEANED_DIR, file), 'utf8'))
		);
		extractions[sourceId] = cleaned.normalizedText;

		const spans = splitIntoSpans(cleaned.normalizedText, cleaned.blocks, countTokens, {
			targetTokens: TARGET_TOKENS
		});
		if (spans.length === 0) throw new Error('E_CHUNK_NO_CHUNKS');

		const cov = checkCoverage(spans, cleaned.normalizedText);
		if (!cov.ok) {
			console.error(`    coverage ${cov.reason} at offset ${cov.at}`);
			throw new Error('E_CHUNK_COVERAGE');
		}

		const seen = new Map();
		const chunks = [];
		for (const s of spans) {
			const anchor = computeAnchor(cleaned.normalizedText, s.startOffset, s.endOffset);
			chunks.push(await toChunk(s, anchor, entry, seen));
		}
		writeFileSync(join(CHUNKS_DIR, `${sourceId}.json`), JSON.stringify(chunks, null, 2));
		allChunks.push(...chunks);

		const sizes = spans.map((s) => countTokens(s.text));
		const tokenLevel = spans.filter((s) => s.brokeAtTokenLevel).length;
		const tiny = sizes.filter((t) => t < TINY_TOKENS).length;
		const noAnchor = chunks.filter((c) => c.anchor === undefined).length;
		if (tokenLevel > 0 || tiny > Math.max(1, Math.floor(spans.length / 2)) || noAnchor > 0)
			flags.push(
				`${sourceId}: ${spans.length} chunks, ${tokenLevel} token-level, ${tiny} tiny, ${noAnchor} no-anchor`
			);
		console.log(
			`[PASS] ${sourceId}  ${String(spans.length).padStart(3)} chunks  (min ${Math.min(...sizes)} / max ${Math.max(...sizes)} tok)`
		);
	} catch (err) {
		console.error(`[FAIL] ${sourceId}: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

const result = validateCorpusAgainstRegistry(allChunks, registry, extractions);
if (!result.valid) {
	console.error('\n[FAIL] cross-ref gate:');
	for (const e of result.errors) console.error(`    ${e.code}  ${e.sourceId}`);
	process.exit(1);
}

console.log('\n' + '='.repeat(60));
console.log(
	`    ${allChunks.length} chunks across ${Object.keys(extractions).length} sources  ->  ${CHUNKS_DIR}/`
);
console.log('    cross-ref gate: PASS');
if (flags.length > 0) {
	console.log('\n    QUALITY SIGNAL (spot-check these):');
	for (const f of flags) console.log(`      ${f}`);
}
console.log('='.repeat(60));
