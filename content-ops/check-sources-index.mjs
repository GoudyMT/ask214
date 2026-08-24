// Run from the repo root: `pnpm check:sources-index` (CI drift gate). Regenerates the public sources
// index in-memory from content/sources.yaml and compares it to the committed artifact
// src/lib/sources/sources-index.data.ts. Fails if they differ (the registry changed without a rebuild)
// or the artifact is missing, so the public About page can never drift from the legal record. Compares
// DATA, not file text, so prettier formatting of the artifact cannot cause a false diff.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateSourcesSchema } from '../src/lib/content-ops/sources-schema.ts';
import { buildSourcesIndex } from '../src/lib/sources/build-index.ts';
import { SOURCES_INDEX } from '../src/lib/sources/sources-index.data.ts';

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

console.log(
	`[check:sources-index] OK: artifact matches the registry (${fresh.agency.length} agency + ${fresh.tapGuides.length} TAP guides)`
);
