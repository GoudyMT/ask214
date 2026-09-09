// Run from the repo root: `pnpm build:sources-index`. Build-only (one of the few places `yaml` is
// imported, keeping that dep out of src/ per the no-third-party-runtime-JS rule). Parses
// content/sources.yaml, runs the schema validator (fail closed), and writes the two committed artifacts
// projected from it by pure src/lib/sources transforms:
//   - sources-index.data.ts   the PUBLIC About index (agency pages + TAP guides behind one library link)
//   - document-urls.data.ts   source id -> that source's own document url, for citation deep links
// They are separate because they answer different questions and the public index deliberately carries no
// source ids. Regenerate after any registry change; `pnpm check:sources-index` gates both for drift.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateSourcesSchema } from '../src/lib/content-ops/sources-schema.ts';
import { buildSourcesIndex } from '../src/lib/sources/build-index.ts';
import { buildDocumentUrls } from '../src/lib/sources/build-document-urls.ts';

const OUT = 'src/lib/sources/sources-index.data.ts';
const OUT_DOCS = 'src/lib/sources/document-urls.data.ts';

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

console.log(
	`[build:sources-index] wrote ${OUT}: ${index.agency.length} agency pages + ${index.tapGuides.length} TAP guides ` +
		`(TAP library ${index.tapLibraryUrl || 'none'})`
);
console.log(
	`[build:sources-index] wrote ${OUT_DOCS}: ${Object.keys(documentUrls).length} document urls`
);
