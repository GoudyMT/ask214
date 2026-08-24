// content-ops/refresh.mjs
// Run from the repo root: `pnpm refresh` (detect), `pnpm refresh --approve <id...>` / `--approve-all`,
// `pnpm refresh --apply`. Build-time refresh pipeline - never runs on a user device or a live server.
// Detect re-captures the auto-fetchable sources into a staging root (via capture-extract's
// REFRESH_STAGING_ROOT mode), compares each content_hash to the shipped baseline, and writes a
// human legal + quality review report + a machine pending-manifest. Manual / PDF sources (Akamai-blocked /
// tapevents SPA) are surfaced as manual-check-required with a self-contained runbook. Approve marks
// sources in the latest manifest as approved; apply promotes their staged captures into the shipped
// baseline, re-chunks + re-embeds the corpus, gates on the eval floor, and stamps the legal record. The
// logic lives in the tested pure units under src/lib/content-ops/refresh/; this script only does IO +
// the subprocess calls.
import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	rmSync,
	readdirSync,
	copyFileSync
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { classifyChange } from '../src/lib/content-ops/refresh/classify-change.ts';
import { diffBlocks } from '../src/lib/content-ops/refresh/diff-blocks.ts';
import { buildReviewReport } from '../src/lib/content-ops/refresh/review-report.ts';
import { stagedFileName } from '../src/lib/content-ops/capture/staged-file.ts';
import { applyApproval } from '../src/lib/content-ops/refresh/approval.ts';
import { stampSourcesYaml } from './backfill/stamp-sources.ts';

/** @typedef {import('../src/lib/content-ops/sources-schema.ts').SourceEntry} SourceEntry */
/** @typedef {import('../src/lib/content-ops/refresh/review-report.ts').ReviewInput} ReviewInput */
/** @typedef {import('../src/lib/content-ops/refresh/review-report.ts').PendingManifest} PendingManifest */
/** @typedef {import('../src/lib/content-ops/refresh/review-report.ts').PendingSource} PendingSource */
/** @typedef {import('./backfill/stamp-sources.ts').IncomingBySourceId} IncomingBySourceId */
/** @typedef {{ content_hash: string, blocks: { text: string, tag?: string }[], normalizedText: string, last_modified?: string }} ExtractedDoc */

const SOURCES_YAML = 'content/sources.yaml';
const BASELINE_EXTRACTED = 'content-ops/extracted'; // the shipped baseline extractions (blocks + content_hash)
const STAGING_ROOT = 'content-ops/refresh/staging'; // the fresh re-capture lands here, never the baseline
const STAGING_EXTRACTED = join(STAGING_ROOT, 'extracted');
const OUT_DIR = 'content-ops/refresh'; // review-<date>.md + pending-<date>.json
const CLEANED_DIR = 'content-ops/cleaned'; // the clean stage's output + approval manifest
const CLEANED_MANIFEST = join(CLEANED_DIR, 'manifest.json');

// yyyy-mm-dd for the artifact names + the buildDate stamp (a normal build-time clock; not a workflow script).
const DATE = new Date().toISOString().slice(0, 10);

/** The self-contained manual-check runbook per source type - paths mirror capture-extract's real conventions
 *  (staged PDFs under content-ops/staged/<name>; saved HTML under content-ops/staged/manual-html/<id>.html).
 *  @param {SourceEntry} entry */
function manualRunbook(entry) {
	if (entry.content_type === 'pdf') {
		const file = stagedFileName(entry.terms_notes) ?? `${entry.source_id}.pdf`;
		return {
			downloadHow:
				'Download the current PDF from the source listing (e.g. the tapevents documents page)',
			placementPath: `content-ops/staged/${file}`
		};
	}
	return {
		downloadHow: 'Open the URL in a browser, then Save Page As -> Web Page, HTML Only',
		placementPath: `content-ops/staged/manual-html/${entry.source_id}.html`
	};
}

/** Read a per-source extracted JSON ({ content_hash, blocks, normalizedText }) or null if absent.
 *  @param {string} dir @param {string} sourceId @returns {ExtractedDoc | null} */
function readExtract(dir, sourceId) {
	const path = join(dir, `${sourceId}.json`);
	return existsSync(path)
		? /** @type {ExtractedDoc} */ (JSON.parse(readFileSync(path, 'utf8')))
		: null;
}

/** SHA-256 hex of the extracted-content fingerprint (normalizedText) - the change-detection signal.
 *  @param {string} s @returns {string} */
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function detect() {
	// Step 1: fresh staging (never touch the baseline dirs).
	rmSync(STAGING_ROOT, { recursive: true, force: true });
	mkdirSync(STAGING_EXTRACTED, { recursive: true });
	mkdirSync(OUT_DIR, { recursive: true });

	// Step 2: re-capture the auto-fetchable sources (plain fetch + headless) into staging via capture-extract's
	// REFRESH_STAGING_ROOT mode - reusing the whole robots / rate-limit / headless pipeline unchanged. Fail-closed:
	// a broken fetch stops capture-extract and names the source (real detection signal, surfaced here).
	console.log('[refresh] re-capturing auto-fetchable sources to staging ...');
	try {
		execFileSync('pnpm', ['exec', 'tsx', 'content-ops/capture-extract.mjs'], {
			env: { ...process.env, REFRESH_STAGING_ROOT: STAGING_ROOT },
			stdio: 'inherit',
			shell: process.platform === 'win32'
		});
	} catch {
		console.error('[refresh] capture-extract failed during detect (see the flagged source above).');
		console.error('[refresh] fix or re-stage that source, then re-run `pnpm refresh`.');
		process.exit(1);
	}

	// Step 3: classify every source - a staging extract present -> auto (hash-compare); absent -> manual-check-required.
	const registry = /** @type {SourceEntry[]} */ (parse(readFileSync(SOURCES_YAML, 'utf8')));
	/** @type {ReviewInput[]} */
	const changes = [];
	for (const entry of registry) {
		const baseline = {
			sourceId: entry.source_id,
			contentHash: entry.content_hash ?? '', // an uncaptured source has no baseline hash yet -> '' sentinel
			...(entry.source_updated_date ? { sourceUpdatedDate: entry.source_updated_date } : {})
		};
		const common = {
			url: entry.url,
			scrapeMethod: entry.scrape_method ?? 'direct_url',
			updateCheck: entry.update_check ?? 'unspecified'
		};
		const staged = readExtract(STAGING_EXTRACTED, entry.source_id);

		if (!staged) {
			// not auto-captured -> manual-check-required (PDF / Akamai-manual)
			const record = classifyChange(baseline, { unfetchable: true });
			changes.push({ ...record, ...common, runbook: manualRunbook(entry) });
			continue;
		}

		// Detect on the EXTRACTED content, not raw bytes: HTML raw bytes carry dynamic noise (session tokens /
		// timestamps) that shift the raw hash every fetch (flagging every source changed with an empty delta). The
		// normalized text is the real signal; apply reads the raw content_hash from the staged extract for sources.yaml.
		const base = readExtract(BASELINE_EXTRACTED, entry.source_id);
		const contentBaseline = {
			sourceId: entry.source_id,
			contentHash: base ? sha256(base.normalizedText) : '',
			...(entry.source_updated_date ? { sourceUpdatedDate: entry.source_updated_date } : {})
		};
		const record = classifyChange(contentBaseline, {
			hash: sha256(staged.normalizedText),
			...(staged.last_modified ? { updatedDate: staged.last_modified } : {})
		});
		/** @type {ReviewInput} */
		const input = {
			...record,
			...common,
			stagedPath: join(STAGING_EXTRACTED, `${entry.source_id}.json`)
		};
		if (record.status === 'changed') {
			const oldBlocks = (base?.blocks ?? []).map((b) => b.text);
			const newBlocks = (staged.blocks ?? []).map((b) => b.text);
			input.diff = diffBlocks(oldBlocks, newBlocks);
		}
		changes.push(input);
	}

	// Step 4: report only what needs attention (changed + manual-check-required); unchanged sources stay silent.
	const relevant = changes.filter((c) => c.status !== 'unchanged');
	const { markdown, manifest } = buildReviewReport(relevant, DATE);
	writeFileSync(join(OUT_DIR, `review-${DATE}.md`), markdown);
	writeFileSync(join(OUT_DIR, `pending-${DATE}.json`), JSON.stringify(manifest, null, 2));

	const changed = relevant.filter((c) => c.status === 'changed').length;
	const manual = relevant.filter((c) => c.status === 'manual-check-required').length;
	console.log(
		`[refresh] ${changed} changed, ${manual} manual-check-required, ` +
			`${changes.length - relevant.length} unchanged (of ${changes.length}) -> ${OUT_DIR}/review-${DATE}.md`
	);
}

const ARGS = process.argv.slice(2);
/** @param {string[]} args */
const RUN_PNPM = (args) =>
	execFileSync('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' });

function latestManifestPath() {
	const files = readdirSync(OUT_DIR)
		.filter((f) => /^pending-.*\.json$/.test(f))
		.sort();
	const last = files[files.length - 1];
	if (last === undefined) throw new Error('E_REFRESH_NO_MANIFEST');
	return join(OUT_DIR, last);
}

function approve() {
	const path = latestManifestPath();
	const manifest = /** @type {PendingManifest} */ (JSON.parse(readFileSync(path, 'utf8')));
	const ids = ARGS.includes('--approve-all')
		? manifest.sources.map((s) => s.sourceId)
		: ARGS.slice(ARGS.indexOf('--approve') + 1).filter((a) => !a.startsWith('--'));
	const updated = applyApproval(manifest, ids); // throws E_REFRESH_UNKNOWN_SOURCE on a bad id
	writeFileSync(path, JSON.stringify(updated, null, 2));
	console.log(`[refresh] approved ${ids.length} source(s) -> ${path}`);
}

function apply() {
	const path = latestManifestPath();
	const manifest = /** @type {PendingManifest} */ (JSON.parse(readFileSync(path, 'utf8')));
	const registry = /** @type {SourceEntry[]} */ (parse(readFileSync(SOURCES_YAML, 'utf8')));
	const byId = new Map(registry.map((e) => [e.source_id, e]));
	// Approved sources split: those with a staged capture (auto-applicable) vs those without. Manual-check
	// sources carry no stagedPath, so warn on them - an operator must never be told "applied N" while an
	// approved source was silently dropped.
	const approvedAll = manifest.sources.filter((s) => s.decision === 'approved');
	const skipped = approvedAll.filter((s) => !s.stagedPath);
	const approved = approvedAll.filter((s) => s.stagedPath);
	if (skipped.length > 0) {
		console.warn(
			`[refresh] WARNING: ${skipped.length} approved source(s) have no staged capture and are NOT applied here ` +
				`(re-ingest them manually per the runbook): ${skipped.map((s) => s.sourceId).join(', ')}`
		);
	}
	if (approved.length === 0) {
		console.log('[refresh] nothing approved with a staged capture to apply.');
		return;
	}

	// Pre-validate EVERY approved source BEFORE promoting any: charset-guard the id + content_hash (both flow
	// into file paths and a shell subprocess) and confirm the staged extract + capture exist. A bad id or a
	// missing artifact fails closed with the working tree untouched, so there is never a half-promoted baseline.
	/** @type {{ s: PendingSource, ext: 'pdf' | 'html', staged: ExtractedDoc, stagedCap: string }[]} */
	const validated = [];
	for (const s of approved) {
		if (!/^[a-z0-9_]+$/.test(s.sourceId)) throw new Error('E_REFRESH_BAD_SOURCE_ID');
		const ext = byId.get(s.sourceId)?.content_type === 'pdf' ? 'pdf' : 'html';
		const staged = readExtract(STAGING_EXTRACTED, s.sourceId);
		if (!staged) throw new Error('E_REFRESH_FETCH_FAILED');
		if (!/^[0-9a-f]{64}$/.test(staged.content_hash)) throw new Error('E_REFRESH_BAD_CONTENT_HASH');
		const stagedCap = join(STAGING_ROOT, 'captures', `${staged.content_hash}.${ext}`);
		if (!existsSync(stagedCap)) throw new Error('E_REFRESH_FETCH_FAILED');
		validated.push({ s, ext, staged, stagedCap });
	}

	// Snapshot every baseline file the promote + re-embed will overwrite (the tracked shipped corpus + each
	// source's untracked extract/chunk), so ANY failure below - a mid-run throw OR a below-floor eval - rolls
	// the working tree back to exactly its pre-apply state. Without this a rejected refresh leaves the corpus
	// regressed AND the extracted baseline overwritten, which a later detect would then read as "unchanged".
	const ROLLBACK = join(OUT_DIR, '.rollback');
	rmSync(ROLLBACK, { recursive: true, force: true });
	mkdirSync(join(ROLLBACK, 'extracted'), { recursive: true });
	mkdirSync(join(ROLLBACK, 'chunks'), { recursive: true });
	mkdirSync(join(ROLLBACK, 'cleaned'), { recursive: true });
	mkdirSync(join(ROLLBACK, 'corpus'), { recursive: true });
	/** @type {{ live: string, backup: string, existed: boolean }[]} */
	const snaps = [];
	/** @param {string} live @param {string} backup */
	const snap = (live, backup) => {
		const existed = existsSync(live);
		if (existed) copyFileSync(live, backup);
		snaps.push({ live, backup, existed });
	};
	snap('static/corpus/corpus-v1.0.1.json', join(ROLLBACK, 'corpus', 'corpus-v1.0.1.json'));
	snap(
		'static/corpus/corpus-v1.0.1.embeddings.bin',
		join(ROLLBACK, 'corpus', 'corpus-v1.0.1.embeddings.bin')
	);
	// The clean stage (run per source below) rewrites cleaned/<id>.json and the shared approval manifest,
	// so both must be in the rollback for a failed apply to fully restore the pre-apply state.
	snap(CLEANED_MANIFEST, join(ROLLBACK, 'cleaned-manifest.json'));
	/** @type {string[]} */
	const newCaptures = [];
	for (const v of validated) {
		snap(
			join(BASELINE_EXTRACTED, `${v.s.sourceId}.json`),
			join(ROLLBACK, 'extracted', `${v.s.sourceId}.json`)
		);
		snap(
			join('content-ops/chunks', `${v.s.sourceId}.json`),
			join(ROLLBACK, 'chunks', `${v.s.sourceId}.json`)
		);
		snap(
			join(CLEANED_DIR, `${v.s.sourceId}.json`),
			join(ROLLBACK, 'cleaned', `${v.s.sourceId}.json`)
		);
		const capPath = join('content-ops/captures', `${v.staged.content_hash}.${v.ext}`);
		if (!existsSync(capPath)) newCaptures.push(capPath); // a genuinely new capture -> delete on rollback
	}
	const restore = () => {
		for (const { live, backup, existed } of snaps) {
			if (existed) copyFileSync(backup, live);
			else if (existsSync(live)) rmSync(live, { force: true });
		}
		for (const cap of newCaptures) if (existsSync(cap)) rmSync(cap, { force: true });
	};

	// Promote (verbatim, no re-fetch) -> re-chunk -> whole-corpus re-embed -> eval gate, all under the guard.
	/** @type {IncomingBySourceId} */
	const incoming = {};
	let evalRegressed = false;
	try {
		for (const v of validated) {
			copyFileSync(
				join(STAGING_EXTRACTED, `${v.s.sourceId}.json`),
				join(BASELINE_EXTRACTED, `${v.s.sourceId}.json`)
			);
			copyFileSync(v.stagedCap, join('content-ops/captures', `${v.staged.content_hash}.${v.ext}`));
			incoming[v.s.sourceId] = {
				contentHash: v.staged.content_hash,
				contentType: v.ext,
				...(v.s.sourceUpdatedDate ? { sourceUpdatedDate: v.s.sourceUpdatedDate } : {})
			};
			console.log(`[refresh] promoted ${v.s.sourceId}; cleaning ...`);
			// The clean stage sits between extracted/ and chunk. Re-derive the cleaned output for the new
			// extraction and re-gate it: a source that cleans to nothing (the common HTML case) auto-approves
			// and proceeds, while one that produces boilerplate edits needs a human's eyes - which this
			// non-interactive apply() cannot provide, so halt with an actionable message rather than let the
			// chunk gate reject the stale cleaned output as an opaque rollback.
			RUN_PNPM(['run', 'clean', v.s.sourceId]);
			const cleanManifest = /** @type {{ sources: { sourceId: string, decision: string }[] }} */ (
				JSON.parse(readFileSync(CLEANED_MANIFEST, 'utf8'))
			);
			const cleanEntry = cleanManifest.sources.find((s) => s.sourceId === v.s.sourceId);
			if (cleanEntry?.decision !== 'approved') throw new Error('E_REFRESH_NEEDS_CLEAN_REVIEW');
			console.log(`[refresh] re-chunking ${v.s.sourceId} ...`);
			RUN_PNPM(['chunk', v.s.sourceId]);
		}
		RUN_PNPM(['embed']);
		try {
			RUN_PNPM(['eval']);
		} catch {
			evalRegressed = true;
			throw new Error('E_REFRESH_EVAL_REGRESSION');
		}
	} catch (err) {
		restore();
		rmSync(ROLLBACK, { recursive: true, force: true });
		const needsReview = err instanceof Error && err.message === 'E_REFRESH_NEEDS_CLEAN_REVIEW';
		const reason = evalRegressed
			? 'E_REFRESH_EVAL_REGRESSION: re-embedded corpus is below the eval floor.'
			: needsReview
				? 'E_REFRESH_NEEDS_CLEAN_REVIEW: a refreshed source produced cleaning edits that need human review. Review content-ops/cleaned/review-<date>.md, approve with `pnpm run clean --approve <id>`, then rebuild the corpus for that source.'
				: `apply failed (${err instanceof Error ? err.message : String(err)}).`;
		console.error(
			`[refresh] ${reason} Rolled back - the working tree is restored to its pre-apply state; nothing shipped.`
		);
		process.exit(1);
	}

	// Success: bump the legal record (comment-preserving via the tested stampSourcesYaml), then drop the snapshot.
	const stamped = stampSourcesYaml(
		readFileSync(SOURCES_YAML, 'utf8'),
		incoming,
		new Date().toISOString()
	);
	writeFileSync(SOURCES_YAML, stamped);
	rmSync(ROLLBACK, { recursive: true, force: true });
	console.log(
		`[refresh] applied ${validated.length} source(s); re-embedded, eval passed, sources.yaml stamped.`
	);
}

if (ARGS.includes('--apply')) apply();
else if (ARGS.includes('--approve') || ARGS.includes('--approve-all')) approve();
else detect();
