// content-ops/refresh.mjs
// Run from the repo root: `pnpm refresh` (detect). Build-time refresh detector - never runs on
// a user device or a live server. Re-captures the auto-fetchable sources into a staging root (via
// capture-extract's REFRESH_STAGING_ROOT mode), compares each content_hash to the shipped baseline, and writes a
// human legal + quality review report + a machine pending-manifest. Manual / PDF sources (Akamai-blocked /
// tapevents SPA) are surfaced as manual-check-required with a self-contained runbook. The logic lives in the
// tested pure units under src/lib/content-ops/refresh/; this script only does IO + the subprocess call.
// `--approve` / `--apply` (promote + re-process) land in the next task; this file is DETECT only.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { classifyChange } from '../src/lib/content-ops/refresh/classify-change.ts';
import { diffBlocks } from '../src/lib/content-ops/refresh/diff-blocks.ts';
import { buildReviewReport } from '../src/lib/content-ops/refresh/review-report.ts';
import { stagedFileName } from '../src/lib/content-ops/capture/staged-file.ts';

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
	const record = classifyChange(contentBaseline, { hash: sha256(staged.normalizedText) });
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
