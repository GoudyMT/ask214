// content-ops/corpus.mjs
// Run from the repo root: `pnpm corpus` (full gated build) or `pnpm corpus --dry-run` (preview only).
// Build-time orchestrator - never runs on a user device or a live server. Drives the existing stage scripts as
// subprocesses, skipping the two costly stages whose output is already current (ingest - no network re-fetch;
// embed - no ~1 min re-embed of byte-identical chunks), and halting at the three human gates (fidelity inside
// ingest, review inside clean, floor inside eval). A reject at any gate stops the chain - never an auto-continue.
// The decision logic lives in the tested pure units under src/lib/content-ops/corpus/; this script is IO glue
// (the refresh.mjs pattern). `refresh` is the network change-DETECTION path; `corpus` is the full gated REBUILD.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { computeChainState } from '../src/lib/content-ops/corpus/chain-state.ts';
import { validatePlacement } from '../src/lib/content-ops/corpus/placement.ts';
import { computeContentRevision } from '../src/lib/content-ops/refresh/content-revision.ts';
import { stagedFileName } from '../src/lib/content-ops/capture/staged-file.ts';

/** @typedef {import('../src/lib/content-ops/sources-schema.ts').SourceEntry} SourceEntry */
/** @typedef {import('../src/lib/content-ops/corpus/placement.ts').ManualSource} ManualSource */
/** @typedef {import('../src/lib/content-ops/corpus/chain-state.ts').ChainState} ChainState */

const SOURCES_YAML = 'content/sources.yaml';
const EXTRACTED_DIR = 'content-ops/extracted';
const CLEANED_MANIFEST = 'content-ops/cleaned/manifest.json';
const CHUNKS_DIR = 'content-ops/chunks';
const CORPUS_JSON = 'static/corpus/corpus-v1.0.json';
const STAGED_DIR = 'content-ops/staged';
const MANUAL_HTML_DIR = join(STAGED_DIR, 'manual-html');

// Akamai-blocked HTML sources ingested from human-saved page HTML (mirrors capture-extract.mjs's CAPTURE_MANUAL).
// PDFs are always human-staged too (tapevents is a SPA that cannot be auto-fetched), so both need a placed file
// before ingest can run - which the placement gate confirms.
const CAPTURE_MANUAL = new Set(['tsp_separation']);

const DRY_RUN = process.argv.slice(2).includes('--dry-run');

/** Run a pnpm subprocess inheriting stdio; a non-zero exit throws and stops the chain (this IS the halt-on-gate:
 *  a stage's internal gate exits non-zero, which propagates here).
 *  @param {string[]} args */
const RUN = (args) =>
	execFileSync('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' });

/** Parse a JSON file, or null if it does not exist.
 *  @param {string} path @returns {any} */
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

/** The clean-stage approval manifest, or an empty one if the clean stage has never run.
 *  @returns {{ sources: { sourceId: string, contentHash: string, decision: string }[] }} */
function readCleanManifest() {
	return readJson(CLEANED_MANIFEST) ?? { sources: [] };
}

/** The per-source on-disk fingerprints, in the shape computeChainState consumes.
 *  @param {SourceEntry[]} registry @returns {import('../src/lib/content-ops/corpus/chain-state.ts').SourceFingerprint[]} */
function buildFingerprints(registry) {
	const cleanById = new Map(readCleanManifest().sources.map((s) => [s.sourceId, s]));
	return registry.map((e) => {
		const extracted = readJson(join(EXTRACTED_DIR, `${e.source_id}.json`));
		const cleanEntry = cleanById.get(e.source_id);
		const decision = cleanEntry?.decision;
		return {
			sourceId: e.source_id,
			extractedContentHash: extracted?.content_hash ?? null,
			cleanedFromContentHash: cleanEntry?.contentHash ?? null,
			cleanedDecision: decision === 'approved' || decision === 'pending' ? decision : null,
			chunksPresent: existsSync(join(CHUNKS_DIR, `${e.source_id}.json`))
		};
	});
}

/** The content fingerprint over the CURRENT per-source chunk files - computed identically to build-corpus.mjs's
 *  stamp, so it compares equal to the committed corpus's contentRevision.contentHash when nothing changed.
 *  @returns {string} */
function chunksContentHash() {
	const files = readdirSync(CHUNKS_DIR)
		.filter((f) => f.endsWith('.json'))
		.sort();
	const chunks = files.flatMap((f) => JSON.parse(readFileSync(join(CHUNKS_DIR, f), 'utf8')));
	return computeContentRevision(
		chunks.map((c) => ({ id: c.id, text: c.text })),
		''
	).contentHash;
}

/** The committed corpus's content fingerprint, or null if no corpus is on disk.
 *  @returns {string | null} */
function corpusContentHash() {
	return readJson(CORPUS_JSON)?.contentRevision?.contentHash ?? null;
}

/** The sources a human must stage a file for before ingest can run: every PDF (tapevents SPA, downloaded by
 *  hand) plus the Akamai-blocked manual-HTML sources. Paths mirror capture-extract.mjs's real staging layout.
 *  @param {SourceEntry[]} registry @returns {ManualSource[]} */
function manualSources(registry) {
	/** @type {ManualSource[]} */
	const manual = [];
	for (const e of registry) {
		if (e.content_type === 'pdf') {
			const file = stagedFileName(e.terms_notes) ?? `${e.source_id}.pdf`;
			manual.push({ sourceId: e.source_id, expectedPath: join(STAGED_DIR, file) });
		} else if (CAPTURE_MANUAL.has(e.source_id)) {
			manual.push({
				sourceId: e.source_id,
				expectedPath: join(MANUAL_HTML_DIR, `${e.source_id}.html`)
			});
		}
	}
	return manual;
}

/** The subset of expected staged paths that actually exist on disk (what validatePlacement checks against).
 *  @param {ManualSource[]} manual @returns {Set<string>} */
function presentStagedFiles(manual) {
	return new Set(manual.map((m) => m.expectedPath).filter((p) => existsSync(p)));
}

/** Print the dry-run stage table: one line per source + the global embed decision + the review-gate list.
 *  @param {ChainState} state */
function printState(state) {
	console.log('='.repeat(60));
	console.log('CORPUS BUILD - DRY RUN (no stage runs)');
	console.log('='.repeat(60));
	console.log(`    ${'source'.padEnd(32)}ingest  clean   chunk`);
	for (const s of state.sources) {
		console.log(`    ${s.sourceId.padEnd(32)}${s.ingest.padEnd(8)}${s.clean.padEnd(8)}${s.chunk}`);
	}
	console.log('    ' + '-'.repeat(52));
	console.log(`    embed: ${state.embed}`);
	console.log(
		`    review gate pending: ${state.reviewGatePending.length ? state.reviewGatePending.join(', ') : '(none)'}`
	);
	console.log('='.repeat(60));
}

function main() {
	const registry = /** @type {SourceEntry[]} */ (parse(readFileSync(SOURCES_YAML, 'utf8')));
	const state = computeChainState({
		sources: buildFingerprints(registry),
		chunksContentHash: chunksContentHash(),
		corpusContentHash: corpusContentHash()
	});

	if (DRY_RUN) {
		printState(state);
		return;
	}

	// Gate 0: legal/schema conformance + manual-source placement, before touching anything.
	RUN(['run', 'validate:sources']);
	const manual = manualSources(registry);
	const placement = validatePlacement(manual, presentStagedFiles(manual));
	if (!placement.ok) {
		for (const m of placement.missing) {
			console.error(
				`[corpus] missing staged file for ${m.sourceId}: place it at ${m.expectedPath}`
			);
		}
		process.exit(1);
	}

	// Stage 1: ingest the stale/missing extractions (the fidelity gate is inside capture-extract; a flagged or
	// failed extract exits non-zero and stops here). Current extractions are skipped - no network re-fetch.
	const toIngest = state.sources.filter((s) => s.ingest === 'run').map((s) => s.sourceId);
	if (toIngest.length) RUN(['ingest', ...toIngest]);
	else console.log('[corpus] ingest: all extractions current, skipped.');

	// Stage 2: clean (cheap + deterministic, always run). Then the REVIEW GATE - any source left pending after
	// the clean run needs a human's eyes, so halt and point at review.html rather than auto-continue past it.
	RUN(['run', 'clean']);
	const pending = readCleanManifest().sources.filter((s) => s.decision === 'pending');
	if (pending.length) {
		console.error(
			`[corpus] ${pending.length} source(s) need review: open content-ops/cleaned/review.html, then ` +
				`approve with \`pnpm run clean --approve ${pending.map((s) => s.sourceId).join(' ')}\` and re-run \`pnpm corpus\`.`
		);
		process.exit(1);
	}

	// Stage 3: chunk (cheap + deterministic; the coverage/anchor gate is inside chunk-sources).
	RUN(['chunk']);

	// Stage 4: embed - skip the ~1 min re-embed when the freshly-chunked output is byte-identical to the
	// committed corpus. Recompute the decision post-chunk so a real chunk change is reflected in the compare.
	const embed = computeChainState({
		sources: buildFingerprints(registry),
		chunksContentHash: chunksContentHash(),
		corpusContentHash: corpusContentHash()
	}).embed;
	if (embed === 'run') RUN(['embed']);
	else console.log('[corpus] embed: corpus already current for these chunks, skipped.');

	// Stage 5: eval - the hard floor gate. A below-floor run exits non-zero and stops the build here.
	RUN(['eval']);

	console.log('[corpus] build complete: all gates passed.');
}

main();
