// Run from the repo root: `pnpm answer-gate`. Scores the shipped short-answer selection against this
// project's own benchmark and fails closed. Three bars, all from the answer-tiers design spec:
//   1. the short answer alone must contain the query's answerSnippet for >= 86% of the answerable queries
//      (the measured result with the shipped sentence splitter - a floor set below what we achieved could
//      not catch a regression back down to it);
//   2. the short answer plus its expansion must reach >= 91%, which is what the 120-word result card
//      reaches today, so nothing a user could previously reach becomes unreachable;
//   3. no selected answer anywhere in the corpus may carry the fused running header.
// It imports the SHIPPED modules rather than reimplementing the policy - a gate that copies the code it
// checks measures the copy. Never lower a bar to make this pass; climb the escalation ladder instead.
import { readFileSync } from 'node:fs';
import { cleanExcerpt } from '../src/lib/corpus/clean-excerpt.ts';
import { stripHeadingEcho } from '../src/lib/ask/answer/heading-echo.ts';
import { selectAnswer } from '../src/lib/ask/answer/select-answer.ts';

const TIER1_FLOOR = 0.86;
const REACH_FLOOR = 0.91;
const CORPUS_PATH = 'static/corpus/corpus-v1.0.1.json';
const QUERIES_PATH = 'src/lib/ask/eval/queries.json';

// ONE verified form, anchored on the literal "Links". A complete enumeration over every chunk returned 16
// matches of the general <word>page <n> shape: 15 were this running header and 1 was real content
// ("...the Find VA Locations webpage 2 Select the Find a VA Location tab..."). Do NOT widen this into a
// pattern family - a speculative list scored 238 dirty chunks that were overwhelmingly legitimate phone
// numbers, pipes and headings. Anything added here is enumerated over the whole corpus and read first.
const JUNK = [{ pattern: /Links\s*page\s*\d/, label: 'running header carried on a Links heading' }];

// A neutral query for the corpus-wide sweep: junk must not survive selection whatever was asked.
const NEUTRAL_QUERY = 'benefits';

/** @typedef {{ id: string; text: string; section?: string; sourceId: string }} GateChunk */
/** @typedef {{ query: string; sourceId?: string; answerSnippet?: string }} EvalItem */

/** @param {string} s */
const norm = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/**
 * The display body both tiers are cut from: cleaned, with the duplicated heading dropped.
 * @param {GateChunk} chunk
 */
const bodyOf = (chunk) => stripHeadingEcho(cleanExcerpt(chunk.text), chunk.section);

function main() {
	console.log('='.repeat(60));
	console.log('ANSWER GATE - SHORT-ANSWER CONTAINMENT + JUNK');
	console.log('='.repeat(60));

	/** @type {{ chunks: GateChunk[] }} */
	const manifest = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
	const chunks = manifest.chunks;
	/** @type {EvalItem[]} */
	const queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));

	// Step 1: pair each answerable query with the chunk that actually holds its answer
	console.log('\n[1/3] Pairing answerable queries to chunks...');
	const pairs = [];
	for (const q of queries) {
		if (!q.sourceId || !q.answerSnippet) continue;
		const needle = norm(q.answerSnippet);
		const chunk = chunks.find(
			(c) => c.sourceId === q.sourceId && norm(c.text).includes(needle.slice(0, 40))
		);
		if (chunk) pairs.push({ query: q.query, needle, chunk });
	}
	console.log(`    answerable queries resolved to a chunk: ${pairs.length}`);

	// Step 2: containment, both tiers
	console.log('\n[2/3] Scoring containment...');
	let short = 0;
	let reach = 0;
	for (const p of pairs) {
		const body = bodyOf(p.chunk);
		if (norm(selectAnswer(body, p.query)).includes(p.needle)) short++;
		if (norm(body).includes(p.needle)) reach++;
	}
	const shortRate = short / pairs.length;
	const reachRate = reach / pairs.length;
	console.log(
		`    short answer alone:   ${(shortRate * 100).toFixed(1)}%  (floor ${(TIER1_FLOOR * 100).toFixed(0)}%)`
	);
	console.log(
		`    short + expansion:    ${(reachRate * 100).toFixed(1)}%  (floor ${(REACH_FLOOR * 100).toFixed(0)}%)`
	);

	// Step 3: junk across every chunk, not only the benchmarked ones
	console.log('\n[3/3] Scanning selected answers over the whole corpus...');
	const dirty = [];
	for (const chunk of chunks) {
		const out = selectAnswer(bodyOf(chunk), NEUTRAL_QUERY);
		for (const { pattern, label } of JUNK) {
			if (pattern.test(out)) dirty.push({ id: chunk.id, label, sample: out.slice(0, 90) });
		}
	}
	console.log(`    chunks scanned: ${chunks.length}    carrying junk: ${dirty.length}`);
	for (const d of dirty.slice(0, 10)) console.log(`      ${d.id}: ${d.label} -> ${d.sample}`);

	const failures = [];
	if (shortRate < TIER1_FLOOR) failures.push('short-answer containment below floor');
	if (reachRate < REACH_FLOOR) failures.push('short + expansion reach below floor');
	if (dirty.length > 0) failures.push(`${dirty.length} chunks carry junk in the selected answer`);

	console.log('\n' + '='.repeat(60));
	if (failures.length > 0) {
		console.log('GATE FAILED: ' + failures.join('; '));
		process.exit(1);
	}
	console.log('GATE PASSED');
}

main();
