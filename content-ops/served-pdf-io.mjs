/**
 * Shared IO for the served-document steps: reading the registry, naming a published file, reading a
 * candidate's derivation record, and extracting a PDF's text layer and image paints.
 *
 * The publisher and the verifier both need these, and they must agree exactly - a verifier that extracted
 * text differently from the publisher would either miss a real defect or invent one. Keeping them in one
 * module is what makes "verified" mean the same thing in both places.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parse } from 'yaml';

import { countImagePaints } from './serve-pdfs-core.mjs';
import { buildSourcesIndex } from '../src/lib/sources/build-index.ts';
import { isServedDocument } from '../src/lib/sources/build-local-documents.ts';
import { joinTextItems } from '../src/lib/sources/pdf-text.ts';

export const SOURCES_PATH = 'content/sources.yaml';
export const CANDIDATE_DIR = 'content-ops/derived';
export const OUTPUT_DIR = 'static/docs';
/** What publishing proved about each served file, committed so CI can hold the files to it without captures. */
export const MANIFEST_PATH = 'content-ops/served-pdfs.json';

/**
 * Bump when the deriving tool's rules or parameters change, together with DERIVATION_VERSION in
 * `content-ops/derive_served_pdfs.py`. The published name is derived from the capture hash plus this value,
 * so raising it re-derives and re-publishes everything; without it a change would keep the old filename and
 * leave stale bytes cached on every device that already has them. The publisher refuses to overwrite a
 * published name with different bytes, and refuses a candidate whose record names another version.
 */
export const DERIVATION_VERSION = '4';

/**
 * @typedef {{sourceId: string, capturedPath: string, contentHash: string}} PdfSource
 */

/**
 * Read the registry and return every served PDF source with its capture path and recorded content hash.
 *
 * Selects with `isServedDocument`, the same function the app's document map is built with, so the files
 * published and the paths the app resolves cannot disagree.
 *
 * @returns {PdfSource[]}
 * @throws {Error} E_SERVED_PDF_NO_CAPTURE when a served source records no capture path or capture hash.
 */
export function pdfSources() {
	/** @type {import('../src/lib/content-ops/sources-schema.ts').SourceEntry[]} */
	const entries = parse(readFileSync(SOURCES_PATH, 'utf-8'));
	return entries.filter(isServedDocument).map((e) => {
		if (
			typeof e.captured_path !== 'string' ||
			typeof e.content_hash !== 'string' ||
			e.content_hash === ''
		) {
			throw Object.assign(new Error('E_SERVED_PDF_NO_CAPTURE'), { sourceId: e.source_id });
		}
		return { sourceId: e.source_id, capturedPath: e.captured_path, contentHash: e.content_hash };
	});
}

/**
 * The derivation record the deriving tool wrote beside a source's candidate.
 *
 * @param {string} sourceId
 * @returns {unknown} The parsed record, or null when there is none.
 * @throws {Error} E_SERVE_BAD_RECORD when the record is not valid JSON.
 */
export function derivationRecord(sourceId) {
	const path = join(CANDIDATE_DIR, `${sourceId}.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf-8'));
	} catch {
		throw new Error('E_SERVE_BAD_RECORD');
	}
}

/**
 * The published filename for a source, derived from its capture identity plus the derivation version.
 *
 * @param {string} sourceId
 * @param {string} contentHash
 * @returns {string}
 */
export function publishedName(sourceId, contentHash) {
	const digest = createHash('sha256').update(`${contentHash}:${DERIVATION_VERSION}`).digest('hex');
	return `${sourceId}.${digest.slice(0, 8)}.pdf`;
}

/**
 * Extract the text of every page with the same reader the app uses.
 *
 * @param {string} path
 * @returns {Promise<string[]>}
 */
export async function pageTexts(path) {
	const data = new Uint8Array(readFileSync(path));
	const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
	const doc = await task.promise;
	/** @type {string[]} */
	const pages = [];
	for (let n = 1; n <= doc.numPages; n += 1) {
		const page = await doc.getPage(n);
		const content = await page.getTextContent();
		// The one construction of page text, shared with the viewer: the matcher's offsets index this
		// string, so the gate must measure exactly what the reader will render against.
		pages.push(joinTextItems(content.items));
		page.cleanup();
	}
	await task.destroy();
	return pages;
}

/**
 * A digest of a text layer, as `pageTexts` returns it.
 *
 * The pages are encoded as a JSON array before hashing, so where one page ends is part of what is hashed.
 * Joining them with a separator character would not be: extracted text can contain any character, and a
 * page holding the separator would hash the same as two pages split at it.
 *
 * @param {string[]} pages
 * @returns {string} Hex SHA-256.
 */
export function textDigest(pages) {
	return createHash('sha256').update(JSON.stringify(pages), 'utf8').digest('hex');
}

/**
 * Count the raster images every page paints, with the same library the app renders it with.
 *
 * Reads each page's operator list - the page's content with every annotation appearance the reader shows -
 * and counts it under `countImagePaints`, the rule the deriving tool's record is written in.
 *
 * @param {string} path
 * @returns {Promise<number[]>} Image paints larger than one pixel on each page, first page first.
 */
export async function pageImagePaints(path) {
	const data = new Uint8Array(readFileSync(path));
	const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
	const doc = await task.promise;
	/** @type {number[]} */
	const painted = [];
	for (let n = 1; n <= doc.numPages; n += 1) {
		const page = await doc.getPage(n);
		painted.push(countImagePaints(await page.getOperatorList(), OPS));
		page.cleanup();
	}
	await task.destroy();
	return painted;
}

/**
 * The number of pages in a PDF, read by the same library the app renders it with.
 *
 * @param {string} path
 * @returns {Promise<number>}
 */
export async function pageCount(path) {
	const data = new Uint8Array(readFileSync(path));
	const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
	const pages = (await task.promise).numPages;
	await task.destroy();
	return pages;
}

/**
 * Title, publisher and page count for every served document, for the Documents area's list.
 *
 * The title and publisher come from the About index's own projection, run on the document's one registry
 * entry, so a document is named the same way on both pages. The page count is read from the published file,
 * so a re-publish that changes it is caught without any registry change.
 *
 * @param {import('../src/lib/content-ops/sources-schema.ts').SourceEntry[]} entries
 * @param {Record<string, string>} localDocuments Source id -> served path, as `buildLocalDocuments` returns it.
 * @returns {Promise<Record<string, import('../src/lib/sources/types.ts').TapGuide & { pages: number }>>}
 */
export async function buildLocalDocumentInfo(entries, localDocuments) {
	/** @type {Record<string, import('../src/lib/sources/types.ts').TapGuide & { pages: number }>} */
	const info = {};
	for (const [sourceId, path] of Object.entries(localDocuments)) {
		const entry = entries.find((e) => e.source_id === sourceId);
		const guide = entry === undefined ? undefined : buildSourcesIndex([entry]).tapGuides[0];
		if (guide === undefined) {
			throw Object.assign(new Error('E_LOCAL_DOCUMENT_INFO_NO_GUIDE'), { sourceId });
		}
		info[sourceId] = { ...guide, pages: await pageCount(`static${path}`) };
	}
	return info;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
export function identical(a, b) {
	return a.length === b.length && a.every((page, i) => page === b[i]);
}
