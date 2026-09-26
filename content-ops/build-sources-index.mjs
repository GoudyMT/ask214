// Run from the repo root: `pnpm build:sources-index`. Build-only (one of the few places `yaml` is
// imported, keeping that dep out of src/ per the no-third-party-runtime-JS rule). Parses
// content/sources.yaml, runs the schema validator (fail closed), and writes the committed artifacts
// projected from it by pure src/lib/sources transforms:
//   - sources-index.data.ts   the PUBLIC About index (agency pages + TAP guides behind one library link)
//   - document-urls.data.ts   source id -> that source's own document url, for citation deep links
//   - local-documents.data.ts source id -> the path OUR served copy is published at, and its byte size,
//                             for the reader
//   - local-document-info.data.ts  source id -> title, publisher and page count, for the Documents area
//   - local-documents-with-pictures.data.ts  the served documents that kept pictures, read from the served
//                             manifest (content-ops/served-pdfs.json), for the reader's line over the pages
// They are separate because they answer different questions and the public index deliberately carries no
// source ids. Regenerate after any registry change; `pnpm check:sources-index` gates both for drift.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateSourcesSchema } from '../src/lib/content-ops/sources-schema.ts';
import { buildSourcesIndex } from '../src/lib/sources/build-index.ts';
import { buildDocumentUrls } from '../src/lib/sources/build-document-urls.ts';
import { buildLocalDocuments } from '../src/lib/sources/build-local-documents.ts';
import { documentsWithPictures } from './serve-pdfs-core.mjs';
import { MANIFEST_PATH, buildLocalDocumentInfo, publishedName } from './served-pdf-io.mjs';

const OUT = 'src/lib/sources/sources-index.data.ts';
const OUT_DOCS = 'src/lib/sources/document-urls.data.ts';
const OUT_LOCAL = 'src/lib/sources/local-documents.data.ts';
const OUT_INFO = 'src/lib/sources/local-document-info.data.ts';
const OUT_PICTURES = 'src/lib/sources/local-documents-with-pictures.data.ts';

const entries = parse(readFileSync('content/sources.yaml', 'utf8'));

// Fail closed: a public artifact is never generated from an invalid legal record.
const { valid, errors } = validateSourcesSchema(entries);
if (!valid) {
	console.error(
		`[build:sources-index] FAIL: sources.yaml has ${errors.length} schema violation(s)`
	);
	for (const e of errors)
		console.error(`    ${e.code}  source=${e.sourceId ?? '?'}  field=${e.field ?? '-'}`);
	process.exit(1);
}

const index = buildSourcesIndex(entries);

const body =
	'// GENERATED - do not edit by hand. Source: content/sources.yaml via content-ops/build-sources-index.mjs.\n' +
	'// Regenerate with `pnpm build:sources-index`; `pnpm check:sources-index` gates drift against the registry.\n' +
	"import type { SourcesIndex } from './types';\n\n" +
	`export const SOURCES_INDEX: SourcesIndex = ${JSON.stringify(index, null, '\t')};\n`;

writeFileSync(OUT, body);

const documentUrls = buildDocumentUrls(entries);

const docsBody =
	'// GENERATED - do not edit by hand. Source: content/sources.yaml via content-ops/build-sources-index.mjs.\n' +
	'// Regenerate with `pnpm build:sources-index`; `pnpm check:sources-index` gates drift against the registry.\n' +
	"import type { DocumentUrls } from './build-document-urls';\n\n" +
	`export const DOCUMENT_URLS: DocumentUrls = ${JSON.stringify(documentUrls, null, '\t')};\n`;

writeFileSync(OUT_DOCS, docsBody);

// The served-copy paths. `publishedName` is imported rather than reimplemented: the publisher writes the
// file under that name, so any second implementation here would put a 404 behind a working citation.
const localDocuments = buildLocalDocuments(entries, publishedName);
// The reader states a document's size before its first download. Read from the published file itself, so
// a missing file fails the build here instead of shipping a path that 404s.
const localSizes = Object.fromEntries(
	Object.entries(localDocuments).map(([id, path]) => [id, statSync(`static${path}`).size])
);

const localBody =
	'// GENERATED - do not edit by hand. Source: content/sources.yaml via content-ops/build-sources-index.mjs.\n' +
	'// Regenerate with `pnpm build:sources-index`; `pnpm check:sources-index` gates drift against the registry.\n' +
	"import type { LocalDocuments } from './build-local-documents';\n\n" +
	`export const LOCAL_DOCUMENTS: LocalDocuments = ${JSON.stringify(localDocuments, null, '\t')};\n\n` +
	`export const LOCAL_DOCUMENT_BYTES: Record<string, number> = ${JSON.stringify(localSizes, null, '\t')};\n`;

writeFileSync(OUT_LOCAL, localBody);

// Its own module, not a third export above: the reader imports that one into the Ask page, and only the
// Documents area reads titles and page counts.
const localInfo = await buildLocalDocumentInfo(entries, localDocuments);

const infoBody =
	'// GENERATED - do not edit by hand. Source: content/sources.yaml via content-ops/build-sources-index.mjs.\n' +
	'// Regenerate with `pnpm build:sources-index`; `pnpm check:sources-index` gates drift against the registry.\n' +
	"import type { TapGuide } from './types';\n\n" +
	`export const LOCAL_DOCUMENT_INFO: Record<string, TapGuide & { pages: number }> = ${JSON.stringify(localInfo, null, '\t')};\n\n` +
	'// How many sources are web pages, which are never re-hosted; the Documents area names the number only.\n' +
	`export const WEB_SOURCE_COUNT = ${index.agency.length};\n`;

writeFileSync(OUT_INFO, infoBody);

// Its own module too, imported only by the reader's page view, which loads when a document is opened: none of
// the pages every route loads carries it.
/** @type {{sourceId: string, keptImages: number}[]} */
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const withPictures = documentsWithPictures(manifest);

const picturesBody =
	'// GENERATED - do not edit by hand. Source: content-ops/served-pdfs.json via content-ops/build-sources-index.mjs.\n' +
	'// Regenerate with `pnpm build:sources-index`; `pnpm check:sources-index` gates drift against the manifest.\n\n' +
	'// The served documents that kept pictures whose own metadata states Public Domain, by source id.\n' +
	`export const LOCAL_DOCUMENTS_WITH_PICTURES: readonly string[] = ${JSON.stringify(withPictures, null, '\t')};\n`;

writeFileSync(OUT_PICTURES, picturesBody);

console.log(
	`[build:sources-index] wrote ${OUT}: ${index.agency.length} agency pages + ${index.tapGuides.length} TAP guides ` +
		`(TAP library ${index.tapLibraryUrl || 'none'})`
);
console.log(
	`[build:sources-index] wrote ${OUT_DOCS}: ${Object.keys(documentUrls).length} document urls`
);
console.log(
	`[build:sources-index] wrote ${OUT_LOCAL}: ${Object.keys(localDocuments).length} served document paths`
);
console.log(
	`[build:sources-index] wrote ${OUT_INFO}: ${Object.keys(localInfo).length} document titles and page counts`
);
console.log(
	`[build:sources-index] wrote ${OUT_PICTURES}: ${withPictures.length} documents that kept pictures`
);
