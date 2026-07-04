// Model-free sanity check for the eval query set: loads all corpus chunks and runs the ground-truth
// resolver over a queries file (arg; default src/lib/ask/eval/queries.json), reporting for each positive
// whether its snippet resolves, to how many chunks, and which. No model, no network. Usage:
//   pnpm exec tsx content-ops/verify-queries.mjs [path/to/queries.json]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveExpectedIds, isHardNegative } from '../src/lib/ask/eval/resolve-ground-truth.ts';

const CHUNKS_DIR = 'content-ops/chunks';
const bySource = new Map();
for (const f of readdirSync(CHUNKS_DIR).filter((f) => f.endsWith('.json'))) {
	for (const c of JSON.parse(readFileSync(join(CHUNKS_DIR, f), 'utf8'))) {
		const list = bySource.get(c.sourceId) ?? [];
		list.push(c);
		bySource.set(c.sourceId, list);
	}
}

const path = process.argv[2] ?? 'src/lib/ask/eval/queries.json';
const queries = JSON.parse(readFileSync(path, 'utf8'));
let miss = 0;
let multi = 0;
for (const q of queries) {
	if (isHardNegative(q)) {
		console.log(`  [neg  ] "${q.query}"`);
		continue;
	}
	const ids = resolveExpectedIds(q, bySource);
	let tag;
	if (ids.length === 0) {
		tag = 'MISS ';
		miss++;
	} else if (ids.length === 1) {
		tag = 'ok   ';
	} else {
		tag = 'MULTI';
		multi++;
	}
	console.log(`  [${tag}] ${q.sourceId} -> ${ids.join(',') || '(none)'}`);
}
console.log(
	`\n${miss === 0 ? '[ok]' : '[FAIL]'} ${queries.length} queries; ${miss} unresolved, ${multi} multi-resolved`
);
if (miss > 0) process.exit(1);
