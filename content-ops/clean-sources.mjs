// content-ops/clean-sources.mjs
// Run from the repo root: `pnpm clean` (optionally one or more source_ids to scope the run) cleans
// every extraction + writes the review report; `pnpm clean --approve <id...>` / `--approve-all`
// marks reviewed sources approved. Build-time cleaning step - never runs on a user device. Drops
// whole-block boilerplate (a table of contents, the standard disclaimer, cover front matter) and
// strips a fused running header/footer from every extracted/<id>.json, writing the cleaned result
// to cleaned/<id>.json under the SAME source_id + content_hash as the extraction (so the chunk
// gate still matches the extraction it was built from). A source with a real edit stays pending
// until a human approves it via the review report; a source cleaning left untouched auto-approves;
// a previously-approved source whose CLEANED OUTPUT hash hasn't changed carries its approval
// forward rather than re-opening the gate - so a cleaning-rules change (same extraction, different
// cleaned result) correctly flips it back to pending even though nothing was re-ingested. The
// logic lives in the tested pure unit at src/lib/content-ops/clean/clean-extraction.ts; this
// script only does IO + the review-gate bookkeeping.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cleanExtraction } from '../src/lib/content-ops/clean/clean-extraction.ts';
import { buildReviewHtml } from '../src/lib/content-ops/corpus/review-html.ts';

/** @typedef {import('../src/lib/content-ops/extract/pdf-text.ts').Block} Block */
/** @typedef {import('../src/lib/content-ops/clean/clean-extraction.ts').CleanReport} CleanReport */
/** @typedef {{ source_id: string, content_hash: string, extractionMode: string, textLayerPresent: boolean, fidelity: unknown, blocks: Block[], normalizedText: string }} ExtractedDoc */
/** @typedef {{ sourceId: string, contentHash: string, cleanedHash: string, decision: 'pending' | 'approved', dropped: number, stripped: number, review: number }} CleanedSource */
/** @typedef {{ generatedAt: string, sources: CleanedSource[] }} CleanedManifest */

const EXTRACTED_DIR = 'content-ops/extracted';
const CLEANED_DIR = 'content-ops/cleaned';
const MANIFEST_PATH = join(CLEANED_DIR, 'manifest.json');

// yyyy-mm-dd for the review report name - a normal build-time clock, not a workflow script.
const DATE = new Date().toISOString().slice(0, 10);

const ARGS = process.argv.slice(2);
/** @param {string} id */
const pick = (id) => ARGS.length === 0 || ARGS.includes(id);

/** SHA-256 hex of the cleaned-output fingerprint (normalizedText) - the approval-gate key. A
 *  cleaning-rules change alters this hash even though the source extraction is untouched, which is
 *  exactly what must re-open the review gate (chunk-sources.mjs's isCleanApproved reads this same
 *  field back and fails closed on a mismatch).
 *  @param {string} s @returns {string} */
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Loads the persisted manifest, or an empty one on the first-ever run.
 *  @returns {CleanedManifest} */
function readManifest() {
	if (!existsSync(MANIFEST_PATH)) return { generatedAt: DATE, sources: [] };
	return /** @type {CleanedManifest} */ (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
}

/** A report with nothing dropped, stripped, or flagged has nothing for a human to review - the
 *  clean source auto-approves itself.
 *  @param {CleanReport} report @returns {boolean} */
function reportIsEmpty(report) {
	return report.dropped.length === 0 && report.stripped.length === 0 && report.review.length === 0;
}

/** @param {CleanReport['dropped'][number]} d @returns {string} */
function renderDropped(d) {
	const page = d.page !== undefined ? `page ${d.page}, ` : '';
	return `- ${page}[${d.kind}]: "${d.preview}"`;
}

/** @param {CleanReport['stripped'][number]} s @returns {string} */
function renderStripped(s) {
	const page = s.page !== undefined ? `page ${s.page}, ` : '';
	return `- ${page}"${s.before}" -> "${s.after}"`;
}

/** @param {CleanReport['review'][number]} r @returns {string} */
function renderReview(r) {
	const page = r.page !== undefined ? `page ${r.page}, ` : '';
	return `- ${page}[${r.kind}] (confidence ${r.confidence.toFixed(2)}): "${r.preview}"`;
}

/** Renders one source's full drop/strip/review detail so a reviewer can confirm only boilerplate
 *  moved, nothing real.
 *  @param {{ sourceId: string, report: CleanReport }} entry @returns {string} */
function renderSourceSection(entry) {
	const { sourceId, report } = entry;
	const lines = [
		`## ${sourceId}  (${report.dropped.length} dropped / ${report.stripped.length} stripped / ${report.review.length} review)`
	];
	if (report.dropped.length > 0)
		lines.push('', '### Dropped', ...report.dropped.map(renderDropped));
	if (report.stripped.length > 0)
		lines.push('', '### Stripped', ...report.stripped.map(renderStripped));
	if (report.review.length > 0)
		lines.push('', '### Flagged for review', ...report.review.map(renderReview));
	return lines.join('\n');
}

/** Builds the human review report: a header, a full section per source with a real edit, and a
 *  single trailing line for the sources cleaning left untouched (nothing there to review).
 *  @param {number} total @param {{ sourceId: string, report: CleanReport }[]} withChanges @returns {string} */
function buildReviewMarkdown(total, withChanges) {
	const clean = total - withChanges.length;
	const parts = [
		`# Corpus clean review - ${DATE}`,
		`${total} sources: ${withChanges.length} with changes to review, ${clean} unchanged.`,
		...withChanges.map(renderSourceSection),
		`${clean} sources unchanged, auto-approved.`
	];
	return parts.join('\n\n');
}

function clean() {
	mkdirSync(CLEANED_DIR, { recursive: true });
	const previous = readManifest();
	const previousById = new Map(previous.sources.map((s) => [s.sourceId, s]));

	const files = readdirSync(EXTRACTED_DIR).filter((f) => f.endsWith('.json'));
	/** @type {CleanedSource[]} */
	const sources = [];
	/** @type {{ sourceId: string, report: CleanReport }[]} */
	const withChanges = [];
	let runCount = 0;

	console.log('='.repeat(60));
	console.log('CONTENT-OPS - CLEAN + REVIEW');
	console.log('='.repeat(60));

	for (const file of files) {
		const sourceId = file.replace(/\.json$/, '');
		const prior = previousById.get(sourceId);
		if (!pick(sourceId)) {
			// Out of scope this run - carry the last-known entry forward untouched so a scoped
			// re-run of one source never drops the other sources from the manifest.
			if (prior) sources.push(prior);
			continue;
		}
		runCount++;
		try {
			const ex = /** @type {ExtractedDoc} */ (
				JSON.parse(readFileSync(join(EXTRACTED_DIR, file), 'utf8'))
			);
			const { cleaned, report } = cleanExtraction(
				{ blocks: ex.blocks, normalizedText: ex.normalizedText },
				{}
			);
			writeFileSync(
				join(CLEANED_DIR, file),
				JSON.stringify(
					{ ...ex, blocks: cleaned.blocks, normalizedText: cleaned.normalizedText },
					null,
					2
				)
			);

			const cleanedHash = sha256(cleaned.normalizedText);
			const noEdits = reportIsEmpty(report);
			// An unchanged CLEANED OUTPUT never re-opens the review gate: only a matching prior
			// approval AND an identical cleanedHash carry the decision forward without a fresh
			// human look. Keying on cleanedHash (not contentHash) means a cleaning-rules change -
			// same extraction, different cleaned result - flips a previously-approved source back
			// to pending, since no human has reviewed THIS exact cleaned output yet.
			const carriedForward = prior?.decision === 'approved' && prior.cleanedHash === cleanedHash;
			/** @type {'pending' | 'approved'} */
			const decision = carriedForward || noEdits ? 'approved' : 'pending';

			sources.push({
				sourceId,
				contentHash: ex.content_hash,
				cleanedHash,
				decision,
				dropped: report.dropped.length,
				stripped: report.stripped.length,
				review: report.review.length
			});
			if (!noEdits) withChanges.push({ sourceId, report });

			console.log(
				`[PASS] ${sourceId}  dropped ${report.dropped.length} / stripped ${report.stripped.length} / review ${report.review.length}`
			);
		} catch (err) {
			console.error(`[FAIL] ${sourceId}: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
	}

	// Preserve the prior generatedAt + the committed tab-indented format when the sources array is
	// byte-identical, so a no-op re-run leaves the tracked manifest git-clean (build-corpus.mjs does the
	// same for its buildDate). A real change stamps today's DATE.
	const generatedAt =
		JSON.stringify(previous.sources) === JSON.stringify(sources) ? previous.generatedAt : DATE;
	writeFileSync(MANIFEST_PATH, JSON.stringify({ generatedAt, sources }, null, '\t') + '\n');
	const reviewPath = join(CLEANED_DIR, `review-${DATE}.md`);
	writeFileSync(reviewPath, buildReviewMarkdown(runCount, withChanges));
	writeFileSync(join(CLEANED_DIR, 'review.html'), buildReviewHtml(withChanges));

	const totalDropped = sources.reduce((sum, s) => sum + s.dropped, 0);
	const totalStripped = sources.reduce((sum, s) => sum + s.stripped, 0);
	const pending = sources.filter((s) => s.decision === 'pending').length;

	console.log('\n' + '='.repeat(60));
	console.log(
		`    ${sources.length} sources tracked  ${totalDropped} dropped / ${totalStripped} stripped total  ->  ${CLEANED_DIR}/`
	);
	console.log(`    ${pending} pending review -> ${reviewPath}`);
	console.log('='.repeat(60));
}

function approve() {
	if (!existsSync(MANIFEST_PATH)) throw new Error('E_CLEAN_NO_MANIFEST');
	const manifest = /** @type {CleanedManifest} */ (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
	const ids = ARGS.includes('--approve-all')
		? manifest.sources.map((s) => s.sourceId)
		: ARGS.slice(ARGS.indexOf('--approve') + 1).filter((a) => !a.startsWith('--'));

	// Mirrors applyApproval: validate every id BEFORE mutating anything, and never interpolate the
	// bad id into the thrown message (mtc/no-input-in-error) - the static code alone identifies it.
	const known = new Set(manifest.sources.map((s) => s.sourceId));
	for (const id of ids) {
		if (!known.has(id)) throw new Error('E_CLEAN_UNKNOWN_SOURCE');
	}

	const approveSet = new Set(ids);
	/** @type {CleanedSource[]} */
	const sources = manifest.sources.map((s) => {
		if (!approveSet.has(s.sourceId)) return s;
		/** @type {CleanedSource} */
		const updated = { ...s, decision: 'approved' };
		return updated;
	});
	writeFileSync(
		MANIFEST_PATH,
		JSON.stringify({ generatedAt: manifest.generatedAt, sources }, null, 2)
	);
	console.log(`[clean] approved ${ids.length} source(s) -> ${MANIFEST_PATH}`);
}

if (ARGS.includes('--approve') || ARGS.includes('--approve-all')) approve();
else clean();
