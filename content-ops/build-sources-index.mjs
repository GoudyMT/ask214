// Run from the repo root: `pnpm build:sources-index`. Build-only (one of the few places `yaml` is
// imported, keeping that dep out of src/ per the no-third-party-runtime-JS rule). Parses
// content/sources.yaml, runs the schema validator (fail closed), projects the PUBLIC index via the
// pure src/lib/sources transform, and writes the committed artifact src/lib/sources/sources-index.data.ts
// that the About page imports. Regenerate after any registry change; `pnpm check:sources-index` gates drift.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateSourcesSchema } from '../src/lib/content-ops/sources-schema.ts';
import { buildSourcesIndex } from '../src/lib/sources/build-index.ts';

const OUT = 'src/lib/sources/sources-index.data.ts';

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

console.log(
	`[build:sources-index] wrote ${OUT}: ${index.agency.length} agency pages + ${index.tapGuides.length} TAP guides ` +
		`(TAP library ${index.tapLibraryUrl || 'none'})`
);
