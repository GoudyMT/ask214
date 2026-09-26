/**
 * Publish the served copies of the PDF source documents into `static/docs/`.
 *
 * Candidates are produced separately (`content-ops/derive_served_pdfs.py`): the text layer kept, every
 * raster image not marked Public Domain in its own metadata removed. This step is the gate. For each served
 * source it checks the candidate's derivation record against the registry, re-extracts the text layer from
 * BOTH the capture and the candidate using the same PDF reader the app uses, compares them page by page, and
 * only then asks `decideServedArtifact` whether the candidate can be served. Verifying here rather than
 * trusting the deriving tool's own report is what keeps a bug in that tool from shipping a document whose
 * citation no longer resolves. There is no fallback to the capture: a source without a servable candidate
 * fails the run.
 *
 * Published names are content-addressed to the CAPTURE plus the derivation version, not to the published
 * bytes, so the expected name is known without doing any work: an unchanged capture means an unchanged name
 * means nothing to do. A recapture changes the registry hash, which changes the name, which is what lets the
 * service worker retire the superseded copy instead of caching both forever. Because the name does not
 * follow the bytes, a published name is never overwritten with different bytes - a device that saved the
 * old ones would keep them under the same name forever. New bytes for an unchanged capture need a new
 * DERIVATION_VERSION.
 *
 * Last, it records every served file in the manifest (`content-ops/served-pdfs.json`), because CI has no
 * captures and cannot prove any of this itself. Each entry holds the file's SHA-256, size and page count,
 * the capture and derivation it came from, the kept image paints its record states (summed over pages, so
 * an image drawn twice counts twice, as the verifier counts them), and a digest of the capture's text
 * layer. The digest is taken only after the published file's text is re-read and found identical to the
 * capture's, so it stands for both. CI holds the committed files to it: the served-documents gate test
 * checks the hashes and sizes, and `check:sources-index` re-extracts every text layer against its digest.
 * Every served document needs its capture and its derivation record for this, even when nothing was
 * published.
 *
 * Run: pnpm serve:pdfs
 */

import { createHash } from 'node:crypto';
import {
	mkdirSync,
	readdirSync,
	copyFileSync,
	readFileSync,
	statSync,
	unlinkSync,
	existsSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';

import { decideServedArtifact, checkDerivationRecord, CAP_BYTES } from './serve-pdfs-core.mjs';
import {
	CANDIDATE_DIR,
	DERIVATION_VERSION,
	MANIFEST_PATH,
	OUTPUT_DIR,
	derivationRecord,
	identical,
	pageTexts,
	pdfSources,
	publishedName,
	textDigest
} from './served-pdf-io.mjs';

/** What each refusal means to the operator, keyed by the error code the gate throws. */
const REFUSAL = {
	E_SERVE_NO_RECORD: 'the candidate has no derivation record beside it. Run `pnpm derive:pdfs`.',
	E_SERVE_BAD_RECORD: "the candidate's derivation record is malformed. Run `pnpm derive:pdfs`.",
	E_SERVE_STALE_DERIVATION:
		'the candidate was derived from a different capture than the registry records. Run `pnpm derive:pdfs`.',
	E_SERVE_DERIVATION_VERSION: `the candidate was derived under another derivation version than ${DERIVATION_VERSION}. Run \`pnpm derive:pdfs\`.`,
	E_SERVE_NO_DERIVATION:
		'there is no candidate, and the capture is never served. Run `pnpm derive:pdfs`.',
	E_SERVE_TEXT_MOVED: "the candidate's text layer differs from the capture's.",
	E_SERVE_PDF_OVER_CAP: `the candidate is over the ${(CAP_BYTES / 1e6).toFixed(1)} MB asset cap.`,
	E_SERVE_PUBLISHED_TEXT_MOVED:
		"the published file's text layer differs from the capture's. Run `pnpm verify:pdfs` to see which pages moved."
};

/**
 * @typedef {{sourceId: string, action: string, bytes: number}} PublishRow
 */

/**
 * @typedef {{
 *   bytes: number,
 *   captureHash: string,
 *   darkenedPages: number[],
 *   derivation: {jpegQuality: number, maxPixels: number},
 *   derivationVersion: string,
 *   file: string,
 *   keptImages: number,
 *   keptPerPage: Record<string, number>,
 *   pages: number,
 *   sha256: string,
 *   sourceId: string,
 *   textDigest: string
 * }} ManifestEntry
 */

/**
 * Report why a source cannot be published, then rethrow the gate's error.
 *
 * @param {string} sourceId
 * @param {unknown} error
 * @returns {never}
 */
function refuse(sourceId, error) {
	const code = error instanceof Error ? error.message : '';
	console.log(' REFUSED');
	console.error(
		`    ${sourceId} cannot be served: ${REFUSAL[/** @type {keyof typeof REFUSAL} */ (code)] ?? code}`
	);
	throw error;
}

async function main() {
	console.log('='.repeat(60));
	console.log('PUBLISH SERVED DOCUMENTS');
	console.log('='.repeat(60));

	console.log('\n[1/5] Reading the source registry...');
	const sources = pdfSources();
	console.log(`    ${sources.length} served PDF sources`);

	mkdirSync(OUTPUT_DIR, { recursive: true });

	console.log('\n[2/5] Verifying candidates and publishing...');
	/** @type {Set<string>} */
	const expected = new Set();
	/** @type {PublishRow[]} */
	const rows = [];
	for (const [index, source] of sources.entries()) {
		const { sourceId, capturedPath, contentHash } = source;
		const name = publishedName(sourceId, contentHash);
		expected.add(name);
		const target = join(OUTPUT_DIR, name);
		const candidatePath = join(CANDIDATE_DIR, `${sourceId}.pdf`);
		const hasCandidate = existsSync(candidatePath);

		if (existsSync(target)) {
			// The name is keyed on the capture and the derivation version, not the bytes, so a different
			// candidate under an existing name means the rules changed without the version moving.
			if (hasCandidate && !readFileSync(candidatePath).equals(readFileSync(target))) {
				console.error(
					`    ${sourceId}: ${name} is already published with different bytes. Raise DERIVATION_VERSION` +
						' in content-ops/served-pdf-io.mjs and content-ops/derive_served_pdfs.py, then derive and publish again.'
				);
				throw new Error('E_SERVE_PDF_NAME_REUSED');
			}
			rows.push({ sourceId, action: 'up to date', bytes: statSync(target).size });
			continue;
		}
		if (!existsSync(capturedPath)) {
			console.error(`    ${sourceId}: capture absent at ${capturedPath} - run \`pnpm ingest\``);
			throw new Error('E_SERVE_PDF_CAPTURE_MISSING');
		}

		process.stdout.write(`    [${index + 1}/${sources.length}] ${sourceId}...`);
		let derived = null;
		if (hasCandidate) {
			try {
				checkDerivationRecord(derivationRecord(sourceId), {
					contentHash,
					derivationVersion: DERIVATION_VERSION
				});
			} catch (error) {
				refuse(sourceId, error);
			}
			const [captureText, candidateText] = await Promise.all([
				pageTexts(capturedPath),
				pageTexts(candidatePath)
			]);
			derived = {
				bytes: statSync(candidatePath).size,
				textIdentical: identical(captureText, candidateText)
			};
		}

		let decision;
		try {
			decision = decideServedArtifact({ derived });
		} catch (error) {
			refuse(sourceId, error);
		}

		copyFileSync(candidatePath, target);
		rows.push({ sourceId, action: 'published', bytes: decision.bytes });
		console.log(` published ${(decision.bytes / 1e6).toFixed(1)} MB`);
	}

	console.log('\n[3/5] Retiring superseded documents...');
	let removed = 0;
	for (const file of readdirSync(OUTPUT_DIR)) {
		if (!file.endsWith('.pdf') || expected.has(file)) continue;
		unlinkSync(join(OUTPUT_DIR, file));
		console.log(`    removed ${file}`);
		removed += 1;
	}
	if (removed === 0) console.log('    nothing to retire');

	console.log('\n[4/5] Recording the served manifest...');
	/** @type {ManifestEntry[]} */
	const manifest = [];
	for (const [index, source] of sources.entries()) {
		const { sourceId, capturedPath, contentHash } = source;
		const file = publishedName(sourceId, contentHash);
		const path = join(OUTPUT_DIR, file);
		if (!existsSync(capturedPath)) {
			console.error(`    ${sourceId}: capture absent at ${capturedPath} - run \`pnpm ingest\``);
			throw new Error('E_SERVE_PDF_CAPTURE_MISSING');
		}
		process.stdout.write(`    [${index + 1}/${sources.length}] ${sourceId}...`);
		let record;
		try {
			record = checkDerivationRecord(derivationRecord(sourceId), {
				contentHash,
				derivationVersion: DERIVATION_VERSION
			});
		} catch (error) {
			refuse(sourceId, error);
		}
		// Re-read from the published bytes, not the candidate's: the digest must stand for what ships.
		const [captureText, servedText] = await Promise.all([pageTexts(capturedPath), pageTexts(path)]);
		if (!identical(captureText, servedText)) {
			refuse(sourceId, new Error('E_SERVE_PUBLISHED_TEXT_MOVED'));
		}
		const bytes = readFileSync(path);
		// Keys in alphabetical order, so the committed file is stable across runs. The kept images and the
		// mid-grey pages are listed by page, so a recapture that changes either shows in its pull request as
		// the pages a person should look at: both come from rules applied to a picture's metadata and to where
		// the page sets its text, and neither rule can see the page.
		manifest.push({
			bytes: bytes.length,
			captureHash: contentHash,
			darkenedPages: record.darkenedPages,
			derivation: record.derivation,
			derivationVersion: DERIVATION_VERSION,
			file,
			keptImages: Object.values(record.keptPerPage).reduce((sum, n) => sum + n, 0),
			keptPerPage: record.keptPerPage,
			pages: servedText.length,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			sourceId,
			textDigest: textDigest(captureText)
		});
		console.log(` ${servedText.length} pages, text identical`);
	}
	manifest.sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
	writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, '\t')}\n`);
	console.log(`    wrote ${MANIFEST_PATH} (${manifest.length} documents)`);

	console.log('\n[5/5] Summary');
	console.log('='.repeat(60));
	console.log(`${'source_id'.padEnd(32)} ${'size'.padStart(9)}     action`);
	console.log('-'.repeat(60));
	let total = 0;
	for (const row of rows) {
		total += row.bytes;
		console.log(
			`${row.sourceId.padEnd(32)} ${(row.bytes / 1e6).toFixed(1).padStart(9)} MB  ${row.action}`
		);
	}
	console.log('-'.repeat(60));
	console.log(`    ${rows.length} documents, ${(total / 1e6).toFixed(1)} MB total`);
	const over = rows.filter((row) => row.bytes > CAP_BYTES).length;
	console.log(`    over the ${(CAP_BYTES / 1e6).toFixed(1)} MB asset cap: ${over}`);
}

await main();
