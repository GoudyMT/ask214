// content-ops/chunk-sources.mjs
// Run from the repo root: `pnpm chunk` (optionally one or more source_ids to scope the run). Build-time
// chunker: reads the per-source extracted text, cuts it into ~256-token verbatim CorpusChunks with citation
// anchors, and writes chunks/<id>.json for the embed step. Never runs on a user device. The logic lives in the
// tested pure units under src/lib/content-ops/chunk/; this script does the IO and loads the real WordPiece
// tokenizer (the same MiniLM the Ask embedder uses, so the token budget matches the model that embeds them).
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { AutoTokenizer } from '@huggingface/transformers';
import { splitIntoSpans } from '../src/lib/content-ops/chunk/split.ts';
import { checkCoverage } from '../src/lib/content-ops/chunk/coverage.ts';
import { computeAnchor } from '../src/lib/content-ops/chunk/anchor.ts';
import { toChunk } from '../src/lib/content-ops/chunk/to-chunk.ts';
import { validateCorpusAgainstRegistry } from '../src/lib/content-ops/corpus-crossref.ts';

const SOURCES_YAML = 'content/sources.yaml';
const EXTRACTED_DIR = 'content-ops/extracted';
const CHUNKS_DIR = 'content-ops/chunks';
// The Ask embedder loads this same repo at dtype q8 (src/lib/ask/embed-worker.ts + embed-sample-corpus.mjs);
// its WordPiece tokenizer defines our budget so no chunk's tail is truncated out of its own vector.
const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const TARGET_TOKENS = 254; // the 256 model window minus the [CLS] + [SEP] specials the model adds
const TINY_TOKENS = 40; // chunks below this are surfaced (not failed) by the quality signal

const ARGS = process.argv.slice(2);
const pick = (id) => ARGS.length === 0 || ARGS.includes(id);

mkdirSync(CHUNKS_DIR, { recursive: true });
const registry = parse(readFileSync(SOURCES_YAML, 'utf8'));
const byId = new Map(registry.map((e) => [e.source_id, e]));

// content tokens only (exclude the [CLS]/[SEP] specials); encode(...) returns the token-id array
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_REPO);
const countTokens = (text) => tokenizer.encode(text, { add_special_tokens: false }).length;

const files = readdirSync(EXTRACTED_DIR).filter((f) => f.endsWith('.json'));
const allChunks = [];
const extractions = {};
const flags = [];

console.log('='.repeat(60));
console.log('CONTENT-OPS - CHUNK + ANCHOR');
console.log('='.repeat(60));

for (const file of files) {
	const sourceId = file.replace(/\.json$/, '');
	if (!pick(sourceId)) continue;
	const entry = byId.get(sourceId);
	if (!entry) {
		console.error(`[FAIL] ${sourceId}: not in ${SOURCES_YAML}`);
		process.exit(1);
	}
	try {
		const ex = JSON.parse(readFileSync(join(EXTRACTED_DIR, file), 'utf8'));
		extractions[sourceId] = ex.normalizedText;

		const spans = splitIntoSpans(ex.normalizedText, ex.blocks, countTokens, {
			targetTokens: TARGET_TOKENS
		});
		if (spans.length === 0) throw new Error('E_CHUNK_NO_CHUNKS');

		const cov = checkCoverage(spans, ex.normalizedText);
		if (!cov.ok) {
			console.error(`    coverage ${cov.reason} at offset ${cov.at}`);
			throw new Error('E_CHUNK_COVERAGE');
		}

		const seen = new Map();
		const chunks = [];
		for (const s of spans) {
			const anchor = computeAnchor(ex.normalizedText, s.startOffset, s.endOffset);
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
		console.error(`[FAIL] ${sourceId}: ${err.message}`);
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
