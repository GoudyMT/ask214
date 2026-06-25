// content-ops/backfill-sources.mjs
// Run from the repo root: `pnpm backfill:sources` (= tsx content-ops/backfill-sources.mjs). Pass source_id(s)
// or a content_type ('pdf' / 'html') as args to scope the run (e.g.
// `pnpm exec tsx content-ops/backfill-sources.mjs va_intent_to_file` for a single source).
//
// A2 BACKFILL. PRODUCER-SIDE / BUILD-TIME ONLY: projects the capture artifacts produced by `pnpm ingest` into
// the sources.yaml LEGAL RECORD. It stamps content_hash / captured_path / captured_at / robots_allowed onto
// each entry, reading the canonical hash from the already-written content-ops/extracted/<id>.json - no
// re-capture, no network. Comment-preserving (the yaml Document API, via stampSourcesYaml) + idempotent (an
// unchanged hash -> a byte-identical no-op). Fail-closed: a missing extracted artifact or audit copy stops the
// run BEFORE any write, printing the offending source_id.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { stampSourcesYaml } from './backfill/stamp-sources.ts';

const SOURCES_YAML = 'content/sources.yaml';
const EXTRACTED_DIR = 'content-ops/extracted'; // per-source extractor output (carries content_hash)
const CAPTURES_DIR = 'content-ops/captures'; // content-addressed audit copies (A2-D5; never served)

// Optional CLI args (source_id(s) and/or a content_type) scope the run; no args = the whole corpus.
const ARGS = process.argv.slice(2);
const pick = (list) =>
	ARGS.length
		? list.filter((e) => ARGS.includes(e.source_id) || ARGS.includes(e.content_type))
		: list;

console.log('='.repeat(60));
console.log('A2 BACKFILL - stamp sources.yaml capture fields from extracted artifacts');
console.log('='.repeat(60));

const before = readFileSync(SOURCES_YAML, 'utf8');
const entries = parse(before);
const inScope = pick(entries);

// Build the incoming map + validate fail-closed BEFORE any write: every in-scope source must have an extracted
// artifact (with a content_hash) AND its content-addressed audit copy on disk (the A2 capture-completeness gate).
const incoming = {};
const problems = [];
for (const entry of inScope) {
	const extractedPath = join(EXTRACTED_DIR, `${entry.source_id}.json`);
	if (!existsSync(extractedPath)) {
		problems.push(`${entry.source_id}: no ${extractedPath}`);
		continue;
	}
	const meta = JSON.parse(readFileSync(extractedPath, 'utf8'));
	const contentHash = meta.content_hash;
	if (typeof contentHash !== 'string' || contentHash.length === 0) {
		problems.push(`${entry.source_id}: extracted artifact has no content_hash`);
		continue;
	}
	const auditCopy = join(CAPTURES_DIR, `${contentHash}.${entry.content_type}`);
	if (!existsSync(auditCopy)) {
		problems.push(`${entry.source_id}: missing audit copy ${auditCopy}`);
		continue;
	}
	incoming[entry.source_id] = { contentHash, contentType: entry.content_type };
}

if (problems.length > 0) {
	console.error(`\n[FAIL] backfill stopped before writing (${problems.length}):`);
	for (const p of problems) console.error(`    ${p}`);
	process.exit(1);
}

// Stamp once (comment-preserving) + write once. Idempotent: an unchanged content_hash keeps its captured_at.
const now = new Date().toISOString();
const after = stampSourcesYaml(before, incoming, now);
writeFileSync(SOURCES_YAML, after);

for (const entry of inScope) {
	const inc = incoming[entry.source_id];
	const state = !entry.content_hash
		? 'new'
		: entry.content_hash === inc.contentHash
			? 'unchanged'
			: 'refreshed';
	console.log(`PASS  ${entry.source_id}  ${inc.contentHash.slice(0, 12)}  [${state}]`);
}
console.log(`\n    stamped ${inScope.length} source(s) -> ${SOURCES_YAML}  (captured_at=${now})`);
