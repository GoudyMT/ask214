// Run from the repo root: `pnpm answer-gate`. Scores the shipped short answer on the ON-DEVICE path and
// fails closed. Self-contained: a local model, a committed corpus, no network and no credentials, so it can
// run offline and in CI.
//
// This is NOT the path most people get. `getDefaultMode()` returns 'online' unless the device has opted out,
// so the online gate (`pnpm answer-gate:bge`) measures the majority path. Both matter: online is the default,
// on-device is the offline promise, and each must beat the lead card it replaced on its OWN retrieval.
//
// The measurement loop is shared with the online gate and unit-tested at src/lib/ask/eval/measure-answer.ts;
// the oracle, the junk scan and the bar are shared via answer-gate-core.mjs. Nothing about the comparison
// lives in this file, so the two gates cannot judge the same feature by different rules.
import { readFileSync } from 'node:fs';
import { pipeline, env } from '@huggingface/transformers';
import { decodeCorpus } from '../src/lib/corpus/index.ts';
import { measureAnswers } from '../src/lib/ask/eval/measure-answer.ts';
import { runOracle, scanJunk, report } from './answer-gate-core.mjs';

// Mirrors of the shipped store's constants (store.svelte.ts). If those change, change these.
const MODEL_ID = 'all-MiniLM-L6-v2';
const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const MIN_SCORE = 0.4;
const K = 5;
// The lead card's word cap (AskResultCard.svelte) - the surface the short answer replaces.
const LEAD_CARD_WORDS = 120;

// The SAME vendored weights the browser serves, not a hub download. embed-worker.ts pins the shipped path
// with allowRemoteModels=false against static/models/, and a model-integrity test pins those bytes by
// SHA-256 - so a gate resolving its own copy from the network measures a model no user runs, and would
// not notice a swap the integrity test exists to catch. It is also what makes this script's "no network"
// claim true, and therefore what makes it runnable in CI.
const LOCAL_MODEL_PATH = 'static/models/';

// Absolute regression floors for THIS path, applied by report(). The on-device path uses a different model
// and a different cutoff than the online one, so it carries its own numbers. Regression guard, not a
// quality bar. Raise one when the feature improves; never lower one to make a run pass.
// RE-DERIVED 2026-09-13 against a DELIBERATELY CHANGED surface, not to make a failing run pass. The answer
// block was reverted to render the lead card's own passage after blind paired judgement measured the
// previous surface shipping misleading text on 28 of 135 queries against that card's 20 - including a wrong
// form number, a wrong helpline, and eligibility text stopping at a colon before its qualifying list.
//
// Coverage genuinely fell with that decision and these numbers say so honestly: tier 1 42.2% -> 39.3% and
// the two-tier answer 50.4% -> 40.7%. Recording the lower figures is the point. A floor left at the old
// value would assert a coverage level this surface never had, and the next person would read the failure as
// a regression rather than as the trade that was chosen.
//
// Each floor is the rate measured on this path less roughly two queries of slack. Raise one when the feature
// genuinely improves; never lower one to make a run pass.
const FLOORS = {
	answered: 0.37, // measured 39.3%, identical to the lead card by construction
	expanded: 0.38, // measured 40.7%
	inTopK: 0.71, // measured 73.3%, untouched by this change - retrieval did not move
	rendered: 0.95 // measured 135 of 135
};

const CORPUS_JSON = 'static/corpus/corpus-v1.0.1.json';
const CORPUS_BIN = 'static/corpus/corpus-v1.0.1.embeddings.bin';
const QUERIES_PATH = 'src/lib/ask/eval/queries.json';

async function main() {
	console.log('='.repeat(66));
	console.log('ANSWER GATE - ON-DEVICE PATH (MiniLM)');
	console.log('='.repeat(66));

	const manifest = JSON.parse(readFileSync(CORPUS_JSON, 'utf8'));
	const buf = readFileSync(CORPUS_BIN);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const corpus = decodeCorpus(manifest, ab, MODEL_ID);
	/** @type {{ query: string; sourceId?: string; answerSnippet?: string }[]} */
	const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
	const scoreable = queries.filter((q) => q.sourceId && q.answerSnippet);

	console.log(
		`\n[1/4] Corpus ${corpus.chunks.length} chunks; scoreable queries ${scoreable.length}`
	);

	env.allowLocalModels = true;
	env.allowRemoteModels = false;
	env.localModelPath = LOCAL_MODEL_PATH;
	const extractor = await pipeline('feature-extraction', MODEL_REPO, { dtype: 'q8' });
	/** @param {string} text */
	const embed = async (text) => {
		const out = await extractor(text, { pooling: 'mean', normalize: true });
		return Float32Array.from(out.data);
	};

	const metrics = await measureAnswers({
		corpus,
		queries,
		embed,
		minScore: MIN_SCORE,
		k: K,
		leadCardWords: LEAD_CARD_WORDS
	});

	const failures = report({
		label: 'on-device',
		metrics,
		leadCardWords: LEAD_CARD_WORDS,
		floors: FLOORS,
		oracle: runOracle(corpus, scoreable),
		dirty: scanJunk(corpus),
		corpusSize: corpus.chunks.length
	});
	if (failures.length > 0) process.exit(1);
}

main();
