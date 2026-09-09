// Run from the repo root: `pnpm check:sources-index` (CI drift gate). Regenerates BOTH artifacts projected
// from content/sources.yaml in-memory and compares them to the committed files
// src/lib/sources/sources-index.data.ts and src/lib/sources/document-urls.data.ts. Fails if either differs
// (the registry changed without a rebuild) or is missing, so neither the public About page nor a citation
// deep link can drift from the legal record. Compares DATA, not file text, so prettier formatting of an
// artifact cannot cause a false diff.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateSourcesSchema } from '../src/lib/content-ops/sources-schema.ts';
import { buildSourcesIndex } from '../src/lib/sources/build-index.ts';
import { buildDocumentUrls } from '../src/lib/sources/build-document-urls.ts';
import { SOURCES_INDEX } from '../src/lib/sources/sources-index.data.ts';
import { DOCUMENT_URLS } from '../src/lib/sources/document-urls.data.ts';

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

const freshDocs = buildDocumentUrls(entries);
if (JSON.stringify(freshDocs) !== JSON.stringify(DOCUMENT_URLS)) {
	console.error(
		'[check:sources-index] FAIL: src/lib/sources/document-urls.data.ts is stale. Run `pnpm build:sources-index` and commit the result.'
	);
	process.exit(1);
}

console.log(
	`[check:sources-index] OK: artifacts match the registry (${fresh.agency.length} agency + ${fresh.tapGuides.length} TAP guides, ` +
		`${Object.keys(freshDocs).length} document urls)`
);
