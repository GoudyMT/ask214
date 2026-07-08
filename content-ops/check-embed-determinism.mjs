// Run from the repo root: `pnpm check:embed-determinism`. Manual model-gated gate (NOT in CI): embeds a small
// fixture twice with the SAME q8 MiniLM the corpus build uses and asserts byte-identical vectors - proving the
// embed step is deterministic, so re-embedding unchanged content yields an unchanged artifact (the property the
// contentRevision stamp relies on). Downloads the model from HF on first run.
import { pipeline } from '@huggingface/transformers';

const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const FIXTURE = [
	'How do I file an intent to file for a VA claim?',
	'terminal leave and separation pay timing',
	'SkillBridge eligibility and approval'
];

// Mirror build-corpus.mjs exactly: q8 dtype, mean pooling, L2-normalized, Float32Array output.
async function embedAll() {
	const extractor = await pipeline('feature-extraction', MODEL_REPO, { dtype: 'q8' });
	const out = [];
	for (const text of FIXTURE) {
		const r = await extractor(text, { pooling: 'mean', normalize: true });
		out.push(Float32Array.from(r.data));
	}
	return out;
}

const first = await embedAll();
const second = await embedAll();

let identical = first.length === second.length;
for (let i = 0; i < first.length; i++) {
	const a = first[i];
	const b = second[i];
	if (a === undefined || b === undefined || !Buffer.from(a.buffer).equals(Buffer.from(b.buffer))) {
		identical = false;
		console.error(`[determinism] FAIL: fixture ${i} vector differs across runs`);
	}
}

console.log(
	identical
		? `[determinism] OK: ${FIXTURE.length} fixtures re-embed byte-identical - embed is deterministic`
		: '[determinism] FAIL: embed is NON-deterministic; the contentRevision stability property does not hold'
);
process.exit(identical ? 0 : 1);
