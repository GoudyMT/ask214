// Run from the repo root: `pnpm answer-gate`. Scores the shipped short answer and fails closed.
//
// WHY THIS RUNS RETRIEVAL. The first version of this gate paired each benchmark query to the chunk that
// CONTAINS its answer, by string search, and reported 86.7%. That is an ORACLE: "given the right chunk,
// does selection find the answer inside it". The shipped store does not get handed that chunk - it takes
// `cards[0]` from real retrieval. Measured end to end the same feature scored 24.4%, which is WORSE than
// the 120-word lead card it replaces. A gate that bypasses the pipeline it guards measures the author's
// intentions, not the product.
//
// So this reports two tiers and gates on the second:
//   ORACLE  - selection quality given the answer-bearing chunk. A diagnostic for tuning the selector.
//             Useful, and never the headline number.
//   SHIPPED - embed -> search -> filterByMinScore -> cards[0] -> the rendered answer. This is the gate.
//
// The floor is COMPUTED, not hard-coded: the same run measures the surface this feature replaces (the
// lead card's 120-word excerpt) over the same queries. The short answer must BEAT what it replaces, or it
// is not an improvement and must not ship. Never lower a bar to make this pass.
import { readFileSync } from 'node:fs';
import { pipeline } from '@huggingface/transformers';
import { decodeCorpus, search, toResultCards } from '../src/lib/corpus/index.ts';
import { cleanExcerpt } from '../src/lib/corpus/clean-excerpt.ts';
import { filterByMinScore } from '../src/lib/ask/threshold.ts';
import { stripHeadingEcho } from '../src/lib/ask/answer/heading-echo.ts';
import { selectAnswer } from '../src/lib/ask/answer/select-answer.ts';
import { toExtractiveAnswer } from '../src/lib/ask/answer/answer-view.ts';

// Mirrors of the shipped store's constants (store.svelte.ts). If those change, change these.
const MODEL_ID = 'all-MiniLM-L6-v2';
const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
const MIN_SCORE = 0.4;
const K = 5;
// The lead card's word cap (AskResultCard.svelte) - the surface the short answer replaces.
const LEAD_CARD_WORDS = 120;

const CORPUS_JSON = 'static/corpus/corpus-v1.0.1.json';
const CORPUS_BIN = 'static/corpus/corpus-v1.0.1.embeddings.bin';
const QUERIES_PATH = 'src/lib/ask/eval/queries.json';

// ONE verified furniture form, anchored on the literal "Links". A complete enumeration over every chunk
// returned 16 matches of the general <word>page <n> shape: 15 were this running header and 1 was real
// content ("...the Find VA Locations webpage 2 Select the Find a VA Location tab..."). Do NOT widen this
// into a pattern family - a speculative list scored 238 dirty chunks that were overwhelmingly legitimate
// phone numbers, pipes and headings. Anything added here is enumerated over the whole corpus and read first.
const JUNK = [{ pattern: /Links\s*page\s*\d/, label: 'running header carried on a Links heading' }];

/** @typedef {{ id: string; text: string; section?: string; sourceId: string }} GateChunk */
/** @typedef {{ query: string; sourceId?: string; answerSnippet?: string }} EvalItem */

/** @param {string} s */
const norm = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** @param {string} s */
const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * The display body both tiers are cut from: cleaned, with the duplicated heading dropped.
 * @param {GateChunk} chunk
 */
const bodyOf = (chunk) => stripHeadingEcho(cleanExcerpt(chunk.text), chunk.section);

/** @param {number} n @param {number} d */
const pct = (n, d) => ((n / d) * 100).toFixed(1) + '%';

async function main() {
	console.log('='.repeat(66));
	console.log('ANSWER GATE - THE SHIPPED PATH, NOT THE ORACLE');
	console.log('='.repeat(66));

	const manifest = JSON.parse(readFileSync(CORPUS_JSON, 'utf8'));
	const buf = readFileSync(CORPUS_BIN);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const corpus = decodeCorpus(manifest, ab, MODEL_ID);
	/** @type {EvalItem[]} */
	const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
	const answerable = queries.filter((q) => q.sourceId && q.answerSnippet);

	console.log(
		`\n[1/4] Corpus ${corpus.chunks.length} chunks; answerable queries ${answerable.length}`
	);

	// --- Tier ORACLE: selection given the answer-bearing chunk. Diagnostic only.
	console.log('\n[2/4] ORACLE (diagnostic): selection given the answer-bearing chunk...');
	let oracleHit = 0;
	let oraclePairs = 0;
	for (const q of answerable) {
		const needle = norm(q.answerSnippet ?? '');
		const chunk = corpus.chunks.find(
			(c) => c.sourceId === q.sourceId && norm(c.text).includes(needle.slice(0, 40))
		);
		if (!chunk) continue;
		oraclePairs++;
		if (norm(selectAnswer(bodyOf(chunk), q.query)).includes(needle)) oracleHit++;
	}
	console.log(
		`    selection quality: ${pct(oracleHit, oraclePairs)} over ${oraclePairs} pairs  (NOT the feature's score)`
	);

	// --- Tier SHIPPED: the real path. This is the gate.
	console.log('\n[3/4] SHIPPED: embed -> search -> cards[0] -> the rendered answer...');
	const extractor = await pipeline('feature-extraction', MODEL_REPO, { dtype: 'q8' });
	/** @param {string} text */
	const embed = async (text) => {
		const out = await extractor(text, { pooling: 'mean', normalize: true });
		return Float32Array.from(out.data);
	};

	let answered = 0; // the rendered short answer contains the answer
	let expanded = 0; // ...after tapping More detail
	let baseline = 0; // the 120-word lead card contained it (the surface being replaced)
	let inTopK = 0; // it was in SOME retrieved card (the reachable ceiling)
	let buriedWrong = 0; // it was in a LATER card while a wrong answer sat on top
	/** @type {number[]} */
	const lengths = [];

	for (const q of answerable) {
		const needle = norm(q.answerSnippet ?? '');
		const vec = await embed(q.query);
		const cards = toResultCards(filterByMinScore(search(vec, corpus, K), MIN_SCORE));
		if (cards.length === 0) continue;
		const top = cards[0];
		if (!top) continue;

		const answer = toExtractiveAnswer(cards, q.query);
		if (!answer) continue;
		lengths.push(wordCount(answer.text));
		const hit = norm(answer.text).includes(needle);
		if (hit) answered++;
		if (norm(answer.passage).includes(needle)) expanded++;
		if (norm(top.excerpt.split(/\s+/).slice(0, LEAD_CARD_WORDS).join(' ')).includes(needle))
			baseline++;
		const idx = cards.findIndex((c) => norm(c.excerpt).includes(needle));
		if (idx >= 0) inTopK++;
		if (idx > 0 && !hit) buriedWrong++;
	}

	const n = answerable.length;
	console.log(`    the rendered short answer contains it   ${pct(answered, n)}   <- THE GATE`);
	console.log(`    after tapping More detail               ${pct(expanded, n)}`);
	console.log(
		`    the ${LEAD_CARD_WORDS}-word lead card contained it     ${pct(baseline, n)}   <- the floor it must beat`
	);
	console.log(`    reachable ceiling (in SOME card)        ${pct(inTopK, n)}`);
	console.log(`    right answer buried under a wrong one   ${pct(buriedWrong, n)}`);

	lengths.sort((a, b) => a - b);
	const at = (/** @type {number} */ f) => lengths[Math.floor(lengths.length * f)] ?? 0;
	const overCard = lengths.filter((w) => w > LEAD_CARD_WORDS).length;
	console.log(
		`    length: median ${at(0.5)}  p90 ${at(0.9)}  max ${lengths[lengths.length - 1] ?? 0}`
	);
	console.log(
		`    longer than the card it replaces: ${overCard} (${pct(overCard, lengths.length)})`
	);

	// --- Junk across every chunk, not only the benchmarked ones.
	console.log('\n[4/4] Scanning selected answers over the whole corpus...');
	const dirty = [];
	for (const chunk of corpus.chunks) {
		const out = selectAnswer(bodyOf(chunk), 'benefits');
		for (const { pattern, label } of JUNK) {
			if (pattern.test(out)) dirty.push({ id: chunk.id, label, sample: out.slice(0, 90) });
		}
	}
	console.log(`    chunks scanned: ${corpus.chunks.length}    carrying junk: ${dirty.length}`);
	for (const d of dirty.slice(0, 10)) console.log(`      ${d.id}: ${d.label} -> ${d.sample}`);

	/** @type {string[]} */
	const failures = [];
	// The bar is comparative and computed in this same run, so it cannot drift from what it replaces.
	if (answered <= baseline) {
		failures.push(
			`the short answer (${pct(answered, n)}) does not beat the ${LEAD_CARD_WORDS}-word card it replaces (${pct(baseline, n)})`
		);
	}
	// A "short" answer longer than the card it replaced has inverted its own premise.
	if (overCard > 0) {
		failures.push(`${overCard} answers are longer than the ${LEAD_CARD_WORDS}-word card`);
	}
	if (dirty.length > 0) failures.push(`${dirty.length} chunks carry junk in the selected answer`);

	console.log('\n' + '='.repeat(66));
	if (failures.length > 0) {
		console.log('GATE FAILED:');
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	console.log('GATE PASSED');
}

main();
