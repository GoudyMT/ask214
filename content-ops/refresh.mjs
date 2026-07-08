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

const SOURCES_YAML = 'content/sources.yaml';
const BASELINE_EXTRACTED = 'content-ops/extracted'; // the shipped baseline extractions (blocks + content_hash)
const STAGING_ROOT = 'content-ops/refresh/staging'; // the fresh re-capture lands here, never the baseline
const STAGING_EXTRACTED = join(STAGING_ROOT, 'extracted');
const OUT_DIR = 'content-ops/refresh'; // review-<date>.md + pending-<date>.json

// yyyy-mm-dd for the artifact names + the buildDate stamp (a normal build-time clock; not a workflow script).
const DATE = new Date().toISOString().slice(0, 10);

/** The self-contained manual-check runbook per source type - paths mirror capture-extract's real conventions
 *  (staged PDFs under content-ops/staged/<name>; saved HTML under content-ops/staged/manual-html/<id>.html). */
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

/** Read a per-source extracted JSON ({ content_hash, blocks, normalizedText }) or null if absent. */
function readExtract(dir, sourceId) {
	const path = join(dir, `${sourceId}.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** SHA-256 hex of the extracted-content fingerprint (normalizedText) - the change-detection signal. */
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
	const registry = parse(readFileSync(SOURCES_YAML, 'utf8'));
	const changes = [];
	for (const entry of registry) {
		const baseline = {
			sourceId: entry.source_id,
			contentHash: entry.content_hash,
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
	const manifest = JSON.parse(readFileSync(path, 'utf8'));
	const ids = ARGS.includes('--approve-all')
		? manifest.sources.map((s) => s.sourceId)
		: ARGS.slice(ARGS.indexOf('--approve') + 1).filter((a) => !a.startsWith('--'));
	const updated = applyApproval(manifest, ids); // throws E_REFRESH_UNKNOWN_SOURCE on a bad id
	writeFileSync(path, JSON.stringify(updated, null, 2));
	console.log(`[refresh] approved ${ids.length} source(s) -> ${path}`);
}

function apply() {
	const path = latestManifestPath();
	const manifest = JSON.parse(readFileSync(path, 'utf8'));
	const registry = parse(readFileSync(SOURCES_YAML, 'utf8'));
	const byId = new Map(registry.map((e) => [e.source_id, e]));
	const approved = manifest.sources.filter((s) => s.decision === 'approved' && s.stagedPath);
	if (approved.length === 0) {
		console.log('[refresh] nothing approved with a staged capture to apply.');
		return;
	}

	// Promote the reviewed staged artifacts -> real dirs VERBATIM (no re-fetch). Fail-closed: a missing
	// staged artifact for an approved source stops the run (never silently thin the corpus).
	const incoming = {};
	for (const s of approved) {
		const ext = byId.get(s.sourceId)?.content_type === 'pdf' ? 'pdf' : 'html';
		const staged = readExtract(STAGING_EXTRACTED, s.sourceId);
		if (!staged) throw new Error('E_REFRESH_FETCH_FAILED');
		const stagedCap = join(STAGING_ROOT, 'captures', `${staged.content_hash}.${ext}`);
		if (!existsSync(stagedCap)) throw new Error('E_REFRESH_FETCH_FAILED');
		copyFileSync(
			join(STAGING_EXTRACTED, `${s.sourceId}.json`),
			join(BASELINE_EXTRACTED, `${s.sourceId}.json`)
		);
		copyFileSync(stagedCap, join('content-ops/captures', `${staged.content_hash}.${ext}`));
		incoming[s.sourceId] = {
			contentHash: staged.content_hash,
			contentType: ext,
			...(s.sourceUpdatedDate ? { sourceUpdatedDate: s.sourceUpdatedDate } : {})
		};
		console.log(`[refresh] promoted ${s.sourceId}; re-chunking ...`);
		RUN_PNPM(['chunk', s.sourceId]);
	}

	// Whole-corpus re-embed (+ contentRevision) then the eval gate. Fail-closed: below-floor eval must NOT
	// ship - stop before the sources.yaml bump; the operator reverts the working tree via git.
	RUN_PNPM(['embed']);
	try {
		RUN_PNPM(['eval']);
	} catch {
		console.error(
			'[refresh] E_REFRESH_EVAL_REGRESSION: re-embedded corpus is below the eval floor. NOT shipping. ' +
				'Revert with: git checkout -- static/corpus content-ops/extracted content-ops/captures'
		);
		process.exit(1);
	}

	// Bump the legal record (content_hash + capture fields + source_updated_date) on the approved entries,
	// comment-preserving via the tested stampSourcesYaml (lineWidth 0, no reflow).
	const stamped = stampSourcesYaml(
		readFileSync(SOURCES_YAML, 'utf8'),
		incoming,
		new Date().toISOString()
	);
	writeFileSync(SOURCES_YAML, stamped);
	console.log(
		`[refresh] applied ${approved.length} source(s); re-embedded, eval passed, sources.yaml stamped.`
	);
}

if (ARGS.includes('--apply')) apply();
else if (ARGS.includes('--approve') || ARGS.includes('--approve-all')) approve();
else detect();
