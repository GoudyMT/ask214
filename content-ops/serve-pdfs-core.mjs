/**
 * Pure decisions for deriving the served copy of a source document.
 *
 * The captures are the legal record and are never served: they carry raster images whose rights nothing in
 * the document clears. A derived copy keeps the text layer byte-identical, removes every raster image whose
 * own metadata does not state Public Domain, and recompresses the ones that stay. The decisions about
 * whether to accept one live here, separate from the PDF handling, so they can be tested without a real
 * document.
 */

/**
 * The platform's per-file static-asset cap. A file above this is unservable, so shipping one would put a
 * 404 behind a citation - the build fails instead.
 */
export const CAP_BYTES = 25 * 1024 * 1024;

/**
 * Decide whether a document's derivation can be served.
 *
 * There is no fallback to the capture at any size: the capture is exactly what the derivation exists to
 * replace, so serving it would re-host the images the derivation removed. Every condition below therefore
 * fails the document rather than choosing other bytes:
 *
 *   - a derivation must exist;
 *   - its extracted text layer must match the capture's on every page, because the runtime highlight
 *     matcher searches that text. A derivation whose text moved would silently break the citation it exists
 *     to support, and the break would be invisible until a reader followed one;
 *   - it must fit the asset cap, or it cannot be served at all.
 *
 * @param {{derived: {bytes: number, textIdentical: boolean} | null}} input The candidate derivation, if one
 *   was produced.
 * @returns {{use: 'derived', bytes: number}} The derivation to serve, and its size.
 * @throws {Error} E_SERVE_NO_DERIVATION when no derivation was produced.
 * @throws {Error} E_SERVE_TEXT_MOVED when the derivation's text layer differs from the capture's.
 * @throws {Error} E_SERVE_PDF_OVER_CAP when the derivation exceeds the asset cap.
 */
export function decideServedArtifact({ derived }) {
	if (derived === null) throw new Error('E_SERVE_NO_DERIVATION');
	if (!derived.textIdentical) throw new Error('E_SERVE_TEXT_MOVED');
	if (derived.bytes > CAP_BYTES) throw new Error('E_SERVE_PDF_OVER_CAP');
	return { use: 'derived', bytes: derived.bytes };
}

/** A page number as a record key: a whole number from 1, written without leading zeros. */
const PAGE_KEY = /^[1-9]\d*$/;

/**
 * Check the record the deriving tool writes beside each candidate, and return its image counts.
 *
 * The candidate's name is derived from the capture hash and the derivation version, so a candidate made
 * from another capture, or by an older version of the rules, would publish under a name that claims
 * something its bytes do not. The record states both, and a mismatch on either rejects the candidate. It
 * also states the settings the kept images were re-encoded with, which the served manifest records.
 *
 * @param {unknown} record The parsed record, or null when the candidate has none.
 * @param {{contentHash: string, derivationVersion: string}} expected The registry's capture hash for the
 *   source, and the pipeline's current derivation version.
 * @returns {{keptPerPage: Record<string, number>, darkenedPages: number[], removed: number,
 *   derivation: {jpegQuality: number, maxPixels: number}}} Images kept per page (pages that keep none are
 *   absent), the pages where a removed image is drawn mid grey under light text, how many images the
 *   derivation removed, and its re-encoding settings.
 * @throws {Error} E_SERVE_NO_RECORD when there is no record.
 * @throws {Error} E_SERVE_STALE_DERIVATION when the record names a different capture.
 * @throws {Error} E_SERVE_DERIVATION_VERSION when the record comes from another derivation version.
 * @throws {Error} E_SERVE_BAD_RECORD when the counts are not whole numbers of images, the mid-grey pages are
 *   not increasing page numbers, or the settings are not whole numbers in range.
 */
export function checkDerivationRecord(record, { contentHash, derivationVersion }) {
	if (record === null || typeof record !== 'object') throw new Error('E_SERVE_NO_RECORD');
	const {
		captureHash,
		darkenedPages,
		derivationVersion: version,
		jpegQuality,
		keptPerPage,
		maxPixels,
		removed
	} = /** @type {any} */ (record);
	if (captureHash !== contentHash) throw new Error('E_SERVE_STALE_DERIVATION');
	if (version !== derivationVersion) throw new Error('E_SERVE_DERIVATION_VERSION');
	const keptValid =
		keptPerPage !== null &&
		typeof keptPerPage === 'object' &&
		Object.entries(keptPerPage).every(
			([page, count]) => PAGE_KEY.test(page) && Number.isInteger(count) && count > 0
		);
	const darkenedValid =
		Array.isArray(darkenedPages) &&
		darkenedPages.every(
			(page, i) => Number.isInteger(page) && page >= 1 && (i === 0 || page > darkenedPages[i - 1])
		);
	if (!keptValid || !darkenedValid || !Number.isInteger(removed) || removed < 0) {
		throw new Error('E_SERVE_BAD_RECORD');
	}
	// The JPEG encoder's quality scale runs from 0 to 100.
	const settingsValid =
		Number.isInteger(jpegQuality) &&
		jpegQuality >= 0 &&
		jpegQuality <= 100 &&
		Number.isInteger(maxPixels) &&
		maxPixels > 0;
	if (!settingsValid) throw new Error('E_SERVE_BAD_RECORD');
	return { keptPerPage, darkenedPages, removed, derivation: { jpegQuality, maxPixels } };
}

/**
 * Count the raster images a page's operator list paints, under the one rule the deriving tool also counts
 * by: a paint of raster pixels more than one pixel in size.
 *
 * A removed image is replaced by a single pixel, so it drops out here, and every image this counts
 * should be one the deriving tool kept. The image object ops carry their size in their arguments; an inline
 * image or a stencil mask carries it on its image data. A single-pixel stencil mask is issued as a solid
 * colour fill and is not an image under this rule.
 *
 * pdf.js merges runs of images into repeat and group ops only when it draws; `getOperatorList()` builds the
 * list without that step. A merged op here means the list came from somewhere this rule was not written
 * for, so it fails rather than guessing how many images the op stands for.
 *
 * @param {{fnArray: number[], argsArray: any[]}} opList A page's operator list, from `getOperatorList()`.
 * @param {Record<string, number>} ops The pdf.js `OPS` table.
 * @returns {number} The number of image paints larger than one pixel.
 * @throws {Error} E_VERIFY_MERGED_IMAGE_OP on a merged image op.
 */
export function countImagePaints({ fnArray, argsArray }, ops) {
	const merged = new Set([
		ops.paintImageXObjectRepeat,
		ops.paintInlineImageXObjectGroup,
		ops.paintImageMaskXObjectGroup,
		ops.paintImageMaskXObjectRepeat
	]);
	let count = 0;
	for (const [i, fn] of fnArray.entries()) {
		const args = argsArray[i];
		if (merged.has(fn)) throw new Error('E_VERIFY_MERGED_IMAGE_OP');
		if (fn === ops.paintImageXObject) {
			if (args[1] * args[2] > 1) count += 1;
		} else if (fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) {
			if (args[0].width * args[0].height > 1) count += 1;
		}
	}
	return count;
}

/**
 * Compare the images each page paints with the images the derivation record says it kept.
 *
 * @param {Record<string, number>} keptPerPage Images kept per page, from checkDerivationRecord.
 * @param {number[]} painted Images painted on each page, first page first, from countImagePaints.
 * @returns {{page: number, expected: number, actual: number}[]} Every page whose counts differ, including a
 *   kept page past the end of the document.
 */
export function keptImageMismatches(keptPerPage, painted) {
	const mismatches = [];
	for (const [i, actual] of painted.entries()) {
		const expected = keptPerPage[String(i + 1)] ?? 0;
		if (expected !== actual) mismatches.push({ page: i + 1, expected, actual });
	}
	for (const [page, expected] of Object.entries(keptPerPage)) {
		if (Number(page) > painted.length) mismatches.push({ page: Number(page), expected, actual: 0 });
	}
	return mismatches;
}

/**
 * A PDF name: a slash, then every character up to the next PDF white-space or delimiter character. PDF
 * white space includes NUL, which the regular-expression class for white space does not, so the set is
 * spelled out rather than borrowed.
 */
const PDF_NAME = /\/[^\0\t\n\f\r ()<>[\]{}/%]*/g;

/**
 * The names that make a viewer act on its own or on the reader's behalf: run a script, start a program, open
 * another file, submit or import form data, unpack an embedded file (from the document's list or an
 * annotation), play media, or run an action without a click. The last three are an object stream and the
 * cross-reference streams that index one: an object stream's dictionaries are compressed out of sight of this
 * scan, and a reader finds them only through a cross-reference stream, which needs no /Type to be read - so a
 * file with any of the three cannot be cleared at all.
 */
const ACTIVE_CONTENT = new Set([
	'/3D',
	'/AA',
	'/EF',
	'/EmbeddedFile',
	'/EmbeddedFiles',
	'/FileAttachment',
	'/GoToE',
	'/GoToR',
	'/ImportData',
	'/JS',
	'/JavaScript',
	'/Launch',
	'/Movie',
	'/OpenAction',
	'/Rendition',
	'/RichMedia',
	'/Screen',
	'/Sound',
	'/SubmitForm',
	'/XFA',
	'/ObjStm',
	'/XRef',
	'/XRefStm'
]);

/**
 * The active-content names a PDF carries, read from its raw bytes.
 *
 * Every dictionary in a file without object streams sits in the raw bytes, so every action, script and
 * embedded file announces itself there by name. A name is compared whole, after its `#` hex escapes are
 * decoded, because that is how a viewer looks it up: `/J#53` is `/JS`, and `/JSON` is not.
 *
 * The whole file is read, stream contents included. Compressed data can spell a listed name by chance,
 * which fails a clean file; skipping streams would instead trust the file's own account of where each one
 * ends, which is what a malformed file gets wrong. Measured over the 21 served files and their captures
 * (208 MB), no compressed data spelled one.
 *
 * @param {string} raw The file's bytes, one character per byte (`latin1`).
 * @returns {string[]} Each listed name found, once, sorted; empty when the file carries none.
 */
export function activeContentIn(raw) {
	return [...pdfNamesIn(raw)].filter((name) => ACTIVE_CONTENT.has(name)).sort();
}

/**
 * Every PDF name in a file's raw bytes, each with its `#` hex escapes decoded.
 *
 * The one reader behind every raw-byte scan here and in the verifier, so what counts as a name - where it
 * ends, and how an escaped character reads - cannot differ between the scan that clears a file of active
 * content and the one that clears it of JPEG 2000.
 *
 * @param {string} raw The file's bytes, one character per byte (`latin1`).
 * @returns {Set<string>} Each distinct decoded name.
 */
export function pdfNamesIn(raw) {
	return new Set(
		(raw.match(PDF_NAME) ?? []).map((name) =>
			name.replace(/#([0-9A-Fa-f]{2})/g, (_escape, hex) => String.fromCharCode(parseInt(hex, 16)))
		)
	);
}

/**
 * The chunks the highlight gate measures: every chunk of a served document that cites a page, split by whether
 * it carries an anchor to search for.
 *
 * A rate over only the anchored chunks cannot see anchors going missing - a rebuild that dropped them would
 * shrink the measured set and still pass - so an unanchored chunk is measured too, as a miss.
 *
 * @template {{sourceId: string, page?: unknown, anchor?: {exact?: string}}} Chunk
 * @param {Chunk[]} chunks The corpus chunks.
 * @param {Set<string>} served The source ids of the served documents.
 * @returns {{anchored: Chunk[], unanchored: Chunk[]}}
 */
export function highlightPopulation(chunks, served) {
	const measured = chunks.filter(
		(c) => served.has(c.sourceId) && c.page !== undefined && c.page !== null
	);
	return {
		anchored: measured.filter((c) => Boolean(c.anchor?.exact)),
		unanchored: measured.filter((c) => !c.anchor?.exact)
	};
}

/**
 * The served files a pull request's commits carry that the manifest at its head does not record.
 *
 * A pull request publishes every commit it carries, and keeps them after a squash merge, so a served file any
 * one of them holds is public even when a later commit replaces it. Only the files the manifest records were
 * proven against their captures and the image rule.
 *
 * @param {{commit: string, path: string, sha256: string}[]} carried Each served file version the commits hold.
 * @param {Set<string>} listed The SHA-256 of every file the manifest records.
 * @returns {{commit: string, path: string, sha256: string}[]} The carried files the manifest does not record.
 */
export function unlistedServedFiles(carried, listed) {
	return carried.filter((file) => !listed.has(file.sha256));
}

/**
 * The served documents that kept any picture - one whose own metadata states Public Domain - by source id.
 *
 * The reader's line over such a document says it is without most of its pictures rather than all of them, so
 * the list is read from what publishing recorded of each file, never kept by hand beside it.
 *
 * @param {{sourceId: string, keptImages: number}[]} manifest The served manifest's entries.
 * @returns {string[]} Their source ids, sorted.
 */
export function documentsWithPictures(manifest) {
	return manifest
		.filter((entry) => entry.keptImages > 0)
		.map((entry) => entry.sourceId)
		.sort();
}
