// Run from the repo root: `pnpm validate:sources` (or `npx tsx content-ops/validate-sources.mjs`).
// Build-only: the ONLY place `yaml` is imported, keeping that dep out of src/ per the
// no-third-party-runtime-JS rule. Parses content/sources.yaml and runs the pure schema validator
// (src/lib/content-ops/sources-schema.ts), prints opaque codes + the offending sourceId/field, and
// exits non-zero on any violation so it can gate CI.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validateSourcesSchema } from '../src/lib/content-ops/sources-schema.ts';

const entries = parse(readFileSync('content/sources.yaml', 'utf8'));
const { valid, errors } = validateSourcesSchema(entries);

if (!valid) {
	console.error(`[FAIL] sources.yaml: ${errors.length} schema violation(s)`);
	for (const e of errors) {
		console.error(`    ${e.code}  source=${e.sourceId ?? '?'}  field=${e.field ?? '-'}`);
	}
	process.exit(1);
}
console.log(`[PASS] sources.yaml: ${entries.length} entries conform to the schema`);
