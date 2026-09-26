/**
 * Verify the PUBLISHED source documents against their captures.
 *
 * This reads the published bytes in `static/docs/` and the captures - never the deriving tool's candidate
 * PDFs - so it checks the bytes that will actually ship rather than the bytes the publisher believed it
 * wrote. From the staging directory it reads only each candidate's derivation record, as the CLAIM to check:
 * how many Public Domain images each page keeps. The count it checks that claim against is measured here,
 * from the published file. A derivation produced outside TypeScript therefore cannot reach users
 * unverified, which is the property the content-ops runtime decision records as the reason the boundary is
 * safe.
 *
 * Checks, each fail-closed:
 *   - every served PDF source has exactly one published file, under its expected content-addressed name,
 *     and the app's generated map points at exactly those files;
 *   - nothing unexpected is sitting in the output directory;
 *   - every published file is within the platform's per-file asset cap;
 *   - every published file's extracted text layer matches its capture's, page for page. The runtime
 *     highlight matcher searches that text, so a document whose text moved would render fine while
 *     silently breaking every citation into it. A missing capture is a failure, not a skip, and so is a run
 *     that checked no pages;
 *   - every page paints exactly the images its derivation record kept, counted under the one rule the
 *     deriving tool also counts by (`countImagePaints`). A removed image is a single pixel and drops
 *     out of the count, so any other image a page paints - one the derivation missed - is a mismatch;
 *   - no image in a published file is JPEG 2000, which the app has no decoder for.
 *
 * Run: pnpm verify:pdfs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
	CAP_BYTES,
	checkDerivationRecord,
	keptImageMismatches,
	pdfNamesIn
} from './serve-pdfs-core.mjs';
import {
	DERIVATION_VERSION,
	OUTPUT_DIR,
	derivationRecord,
	identical,
	pageImagePaints,
	pageTexts,
	pdfSources,
	publishedName
} from './served-pdf-io.mjs';
import { LOCAL_DOCUMENTS } from '../src/lib/sources/local-documents.data.ts';

/**
 * Why a PDF's raw bytes cannot be cleared of JPEG 2000 images.
 *
 * Read from the raw file rather than through pdf.js, because pdf.js does not report an image's encoding and
 * an image no page draws never reaches its operator list. An image is a stream, and a stream's dictionary
 * always sits in the file itself, so its filter name is visible here. A name can spell a character as `#`
 * and two hex digits, so every name is compared after decoding those. A filter given by reference could
 * point into a compressed object stream, which this scan cannot read, so a file with one fails too.
 *
 * @param {string} path
 * @returns {string[]} Each reason the file fails; empty when it passes.
 */
function jpegTwoThousandIn(path) {
	const names = pdfNamesIn(readFileSync(path).toString('latin1'));
	/** @type {string[]} */
	const reasons = [];
	if (names.has('/JPXDecode')) reasons.push('jpx');
	if (names.has('/ObjStm')) reasons.push('object streams');
	return reasons;
}

async function main() {
	console.log('='.repeat(60));
	console.log('VERIFY SERVED DOCUMENTS');
	console.log('='.repeat(60));

	const sources = pdfSources();
	/** @type {string[]} */
	const failures = [];
	const expected = new Set(sources.map((s) => publishedName(s.sourceId, s.contentHash)));

	console.log(`\n[1/4] Checking the output directory (${sources.length} sources expected)...`);
	if (!existsSync(OUTPUT_DIR)) {
		console.error(`    ${OUTPUT_DIR} does not exist - run \`pnpm serve:pdfs\``);
		throw new Error('E_VERIFY_PDF_NO_OUTPUT');
	}
	const present = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('.pdf')));
	for (const name of expected) {
		if (!present.has(name)) failures.push(`missing: ${name}`);
	}
	for (const name of present) {
		if (!expected.has(name)) failures.push(`unexpected: ${name}`);
	}
	console.log(`    ${present.size} published, ${expected.size} expected`);

	// The app reaches a document ONLY through the generated map, and the drift gate compares that map to
	// the registry rather than to the filesystem - so a map pointing at files nobody published passes there
	// and 404s every citation here. This is the only check that closes that loop.
	const mapped = Object.values(LOCAL_DOCUMENTS);
	for (const path of mapped) {
		const name = path.replace(/^\/docs\//, '');
		if (!present.has(name)) failures.push(`mapped but not published: ${path}`);
	}
	const mappedNames = new Set(mapped.map((p) => p.replace(/^\/docs\//, '')));
	for (const name of present) {
		if (!mappedNames.has(name)) failures.push(`published but unreachable from the app: ${name}`);
	}
	console.log(`    ${mapped.length} reachable through the generated map`);

	console.log('\n[2/4] Checking sizes against the asset cap...');
	let total = 0;
	for (const name of expected) {
		const path = join(OUTPUT_DIR, name);
		if (!existsSync(path)) continue;
		const bytes = statSync(path).size;
		total += bytes;
		if (bytes > CAP_BYTES) failures.push(`over cap: ${name} at ${(bytes / 1e6).toFixed(1)} MB`);
	}
	console.log(
		`    ${(total / 1e6).toFixed(1)} MB total, cap is ${(CAP_BYTES / 1e6).toFixed(1)} MB per file`
	);

	console.log('\n[3/4] Checking each text layer against its capture...');
	let pagesChecked = 0;
	for (const [index, source] of sources.entries()) {
		const path = join(OUTPUT_DIR, publishedName(source.sourceId, source.contentHash));
		// A missing published file is already a failure from step 1.
		if (!existsSync(path)) continue;
		if (!existsSync(source.capturedPath)) {
			failures.push(`capture missing: ${source.sourceId} at ${source.capturedPath}`);
			continue;
		}
		process.stdout.write(`    [${index + 1}/${sources.length}] ${source.sourceId}...`);
		const [captureText, publishedText] = await Promise.all([
			pageTexts(source.capturedPath),
			pageTexts(path)
		]);
		pagesChecked += captureText.length;
		if (identical(captureText, publishedText)) {
			console.log(` same (${captureText.length} pages)`);
		} else {
			const moved = captureText.filter((page, i) => page !== publishedText[i]).length;
			console.log(' MOVED');
			failures.push(`text moved: ${source.sourceId} on ${moved} of ${captureText.length} pages`);
		}
	}
	if (pagesChecked === 0) failures.push('no page was checked');

	console.log('\n[4/4] Checking the images each page paints against its derivation record...');
	let imagesChecked = 0;
	for (const [index, source] of sources.entries()) {
		const path = join(OUTPUT_DIR, publishedName(source.sourceId, source.contentHash));
		if (!existsSync(path)) continue;
		process.stdout.write(`    [${index + 1}/${sources.length}] ${source.sourceId}...`);
		let kept;
		try {
			kept = checkDerivationRecord(derivationRecord(source.sourceId), {
				contentHash: source.contentHash,
				derivationVersion: DERIVATION_VERSION
			}).keptPerPage;
		} catch (error) {
			console.log(' NO VALID RECORD');
			failures.push(`record: ${source.sourceId} ${error instanceof Error ? error.message : error}`);
			continue;
		}
		const painted = await pageImagePaints(path);
		const mismatches = keptImageMismatches(kept, painted);
		const encodings = jpegTwoThousandIn(path);
		const count = painted.reduce((sum, n) => sum + n, 0);
		imagesChecked += count;
		if (mismatches.length === 0 && encodings.length === 0) {
			console.log(` ${count} kept image paint(s) on ${painted.length} pages, as recorded`);
			continue;
		}
		console.log(' MISMATCH');
		for (const { page, expected: want, actual } of mismatches) {
			failures.push(
				`images: ${source.sourceId} page ${page} paints ${actual}, record kept ${want}`
			);
		}
		for (const reason of encodings) failures.push(`${reason}: ${source.sourceId}`);
	}

	console.log(`\n${'='.repeat(60)}`);
	if (failures.length === 0) {
		console.log(
			`VERIFIED - ${sources.length} documents, ${pagesChecked} pages, ${imagesChecked} kept image paints, 0 failures`
		);
		return;
	}
	console.log(`FAILED - ${failures.length} problem(s)`);
	for (const failure of failures) console.log(`    ${failure}`);
	throw new Error('E_VERIFY_PDF_FAILED');
}

await main();
