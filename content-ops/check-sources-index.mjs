// Run from the repo root: `pnpm check:sources-index` (CI drift gate). Regenerates BOTH artifacts projected
// from content/sources.yaml in-memory and compares them to the committed files
// src/lib/sources/sources-index.data.ts and src/lib/sources/document-urls.data.ts. Fails if either differs
// (the registry changed without a rebuild) or is missing, so neither the public About page nor a citation
// deep link can drift from the legal record. Compares DATA, not file text, so prettier formatting of an
// artifact cannot cause a false diff.
//
// It then checks the served documents themselves, which CI cannot compare with their captures: each one's
// text layer is re-extracted with the reader publishing used and compared with the digest publishing took
// from the capture (content-ops/served-pdfs.json), and every file in the documents folder is scanned for
// content a PDF viewer would run, launch, submit or unpack.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validateSourcesSchema } from '../src/lib/content-ops/sources-schema.ts';
import { buildSourcesIndex } from '../src/lib/sources/build-index.ts';
import { buildDocumentUrls } from '../src/lib/sources/build-document-urls.ts';
import { buildLocalDocuments } from '../src/lib/sources/build-local-documents.ts';
import { activeContentIn, documentsWithPictures } from './serve-pdfs-core.mjs';
import {
	MANIFEST_PATH,
	OUTPUT_DIR,
	buildLocalDocumentInfo,
	pageTexts,
	publishedName,
	textDigest
} from './served-pdf-io.mjs';
import { SOURCES_INDEX } from '../src/lib/sources/sources-index.data.ts';
import { DOCUMENT_URLS } from '../src/lib/sources/document-urls.data.ts';
import { LOCAL_DOCUMENTS, LOCAL_DOCUMENT_BYTES } from '../src/lib/sources/local-documents.data.ts';
import {
	LOCAL_DOCUMENT_INFO,
	WEB_SOURCE_COUNT
} from '../src/lib/sources/local-document-info.data.ts';
import { LOCAL_DOCUMENTS_WITH_PICTURES } from '../src/lib/sources/local-documents-with-pictures.data.ts';

const entries = parse(readFileSync('content/sources.yaml', 'utf8'));

const { valid } = validateSourcesSchema(entries);
if (!valid) {
	console.error(
		'[check:sources-index] FAIL: sources.yaml is invalid; run `pnpm validate:sources`.'
	);
	process.exit(1);
}

const fresh = buildSourcesIndex(entries);
if (JSON.stringify(fresh) !== JSON.stringify(SOURCES_INDEX)) {
	console.error(
		'[check:sources-index] FAIL: src/lib/sources/sources-index.data.ts is stale. Run `pnpm build:sources-index` and commit the result.'
	);
	process.exit(1);
}

const freshLocal = buildLocalDocuments(entries, publishedName);
if (JSON.stringify(freshLocal) !== JSON.stringify(LOCAL_DOCUMENTS)) {
	console.error(
		'[check:sources-index] FAIL: src/lib/sources/local-documents.data.ts is stale. Run `pnpm build:sources-index` and commit the result.'
	);
	process.exit(1);
}

// A re-published document changes size without changing the registry, so the sizes are checked against
// the files on disk, not only against sources.yaml.
const freshSizes = Object.fromEntries(
	Object.entries(freshLocal).map(([id, path]) => [id, statSync(`static${path}`).size])
);
if (JSON.stringify(freshSizes) !== JSON.stringify(LOCAL_DOCUMENT_BYTES)) {
	console.error(
		'[check:sources-index] FAIL: the document sizes in src/lib/sources/local-documents.data.ts are stale. Run `pnpm build:sources-index` and commit the result.'
	);
	process.exit(1);
}

// Page counts, like sizes, come from the files on disk, so a re-publish is caught here too.
const freshInfo = await buildLocalDocumentInfo(entries, freshLocal);
if (
	JSON.stringify(freshInfo) !== JSON.stringify(LOCAL_DOCUMENT_INFO) ||
	fresh.agency.length !== WEB_SOURCE_COUNT
) {
	console.error(
		'[check:sources-index] FAIL: src/lib/sources/local-document-info.data.ts is stale. Run `pnpm build:sources-index` and commit the result.'
	);
	process.exit(1);
}

const freshDocs = buildDocumentUrls(entries);
if (JSON.stringify(freshDocs) !== JSON.stringify(DOCUMENT_URLS)) {
	console.error(
		'[check:sources-index] FAIL: src/lib/sources/document-urls.data.ts is stale. Run `pnpm build:sources-index` and commit the result.'
	);
	process.exit(1);
}

if (!existsSync(MANIFEST_PATH)) {
	console.error(
		`[check:sources-index] FAIL: ${MANIFEST_PATH} is missing. Run \`pnpm serve:pdfs\` and commit the result.`
	);
	process.exit(1);
}
/** @type {{sourceId: string, file: string, textDigest: string, keptImages: number}[]} */
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

// The reader says from this list which documents are without most of their pictures, not all of them, so a
// re-publish that keeps pictures in another document, or none in one, is caught here as the sizes are.
if (
	JSON.stringify(documentsWithPictures(manifest)) !== JSON.stringify(LOCAL_DOCUMENTS_WITH_PICTURES)
) {
	console.error(
		'[check:sources-index] FAIL: src/lib/sources/local-documents-with-pictures.data.ts is stale. Run `pnpm build:sources-index` and commit the result.'
	);
	process.exit(1);
}

// The highlight matcher searches this text, so a file whose text moved still opens and renders while every
// citation into it stops resolving. Nothing else in CI would notice.
const moved = [];
for (const [sourceId, path] of Object.entries(freshLocal)) {
	const entry = manifest.find((e) => e.sourceId === sourceId);
	if (entry === undefined || `/docs/${entry.file}` !== path) {
		console.error(
			`[check:sources-index] FAIL: ${MANIFEST_PATH} does not record ${path}. Run \`pnpm serve:pdfs\` and commit the result.`
		);
		process.exit(1);
	}
	if (textDigest(await pageTexts(`static${path}`)) !== entry.textDigest) moved.push(sourceId);
}
if (moved.length > 0) {
	console.error(
		`[check:sources-index] FAIL: the text layer of ${moved.join(', ')} no longer matches the digest taken from the capture. ` +
			'Find what changed the file or its extraction; do not re-record the digest to match.'
	);
	process.exit(1);
}

// Every file, not only the mapped ones: anything in the folder is served, whether the app links to it or not.
const active = [];
const scanned = readdirSync(OUTPUT_DIR).sort();
for (const file of scanned) {
	const found = activeContentIn(readFileSync(join(OUTPUT_DIR, file)).toString('latin1'));
	if (found.length > 0) active.push(`${file} (${found.join(' ')})`);
}
if (active.length > 0) {
	console.error(
		`[check:sources-index] FAIL: served files carry active content or object streams: ${active.join('; ')}.`
	);
	process.exit(1);
}

console.log(
	`[check:sources-index] OK: artifacts match the registry (${fresh.agency.length} agency + ${fresh.tapGuides.length} TAP guides, ` +
		`${Object.keys(freshDocs).length} document urls, ${Object.keys(freshLocal).length} served documents); ` +
		`${Object.keys(freshLocal).length} text layers match the manifest; no active content in ${scanned.length} served files`
);
