// Shared by the two answer gates (`pnpm answer-gate` on-device, `pnpm answer-gate:bge` online). Everything
// here is path-INDEPENDENT: the oracle diagnostic, the junk scan, and the report + pass/fail decision. Only
// the corpus artifact, the embedder, and the display cutoff differ between paths, and those live in the two
// entry scripts. One copy of the bar means the two gates cannot drift into judging the same feature
// differently - which is the failure this split exists to prevent.
import { cleanExcerpt } from '../src/lib/corpus/clean-excerpt.ts';
import { stripHeadingEcho } from '../src/lib/ask/answer/heading-echo.ts';
import { selectAnswer } from '../src/lib/ask/answer/select-answer.ts';
import { mcnemarExactP } from '../src/lib/ask/eval/measure-answer.ts';

// The improvement must be distinguishable from chance, not merely positive. Standard two-sided level; the
// bar itself comes from the data via McNemar, so this is the only judgement call in the comparison.
const ALPHA = 0.05;

// ONE verified furniture form, anchored on the literal "Links". A complete enumeration over every chunk
// returned 16 matches of the general <word>page <n> shape: 15 were this running header and 1 was real
// content ("...the Find VA Locations webpage 2 Select the Find a VA Location tab..."). Do NOT widen this
// into a pattern family - a speculative list scored 238 dirty chunks that were overwhelmingly legitimate
// phone numbers, pipes and headings. Anything added here is enumerated over the whole corpus and read first.
const JUNK = [{ pattern: /Links\s*page\s*\d/, label: 'running header carried on a Links heading' }];

/** @typedef {{ id: string; text: string; section?: string; sourceId: string }} GateChunk */
/** @typedef {{ query: string; sourceId?: string; answerSnippet?: string }} EvalItem */
/** @typedef {{ n: number; answered: number; expanded: number; baseline: number; inTopK: number; buriedWrong: number; bestCardAnswered: number; answerOnly: number; cardOnly: number; headSameCard: number; headLeadCard: number; lengths: number[] }} AnswerMetrics */

/** @param {string} s */
export const norm = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/**
 * The display body both answer tiers are cut from: cleaned, with the duplicated heading dropped.
 * @param {GateChunk} chunk
 */
export const bodyOf = (chunk) => stripHeadingEcho(cleanExcerpt(chunk.text), chunk.section);

/** @param {number} n @param {number} d */
export const pct = (n, d) => (d === 0 ? 'n/a' : ((n / d) * 100).toFixed(1) + '%');

/**
 * Selection quality GIVEN the answer-bearing chunk. A diagnostic for tuning the selector, never the
 * headline: the shipped store is not handed the right chunk, it takes what retrieval returned. The first
 * version of this gate reported the oracle as the feature's score and overstated it by roughly 3x.
 *
 * @param {{ chunks: GateChunk[] }} corpus
 * @param {EvalItem[]} queries Already filtered to the scoreable ones.
 * @returns {{ hit: number; pairs: number }}
 */
export function runOracle(corpus, queries) {
	let hit = 0;
	let pairs = 0;
	for (const q of queries) {
		const needle = norm(q.answerSnippet ?? '');
		const chunk = corpus.chunks.find(
			(c) => c.sourceId === q.sourceId && norm(c.text).includes(needle.slice(0, 40))
		);
		if (!chunk) continue;
		pairs++;
		if (norm(selectAnswer(bodyOf(chunk), q.query)).includes(needle)) hit++;
	}
	return { hit, pairs };
}

/**
 * Junk carried into a SELECTED answer, over every chunk rather than only the benchmarked ones. The
 * benchmark touches a few hundred chunks; furniture can sit anywhere in 1878.
 *
 * @param {{ chunks: GateChunk[] }} corpus
 * @returns {{ id: string; label: string; sample: string }[]}
 */
export function scanJunk(corpus) {
	const dirty = [];
	for (const chunk of corpus.chunks) {
		const out = selectAnswer(bodyOf(chunk), 'benefits');
		for (const { pattern, label } of JUNK) {
			if (pattern.test(out)) dirty.push({ id: chunk.id, label, sample: out.slice(0, 90) });
		}
	}
	return dirty;
}

/**
 * Print the run and decide pass/fail.
 *
 * The bar is COMPUTED in the same run, never hard-coded: the short answer must beat the lead-card excerpt
 * it replaces, measured over the same queries on the same path. A bar carried in a constant drifts from
 * the thing it is supposed to be comparing against; one measured alongside cannot.
 *
 * @param {{ label: string; metrics: AnswerMetrics; leadCardWords: number; oracle: { hit: number; pairs: number }; dirty: { id: string; label: string; sample: string }[]; corpusSize: number }} input
 * @returns {string[]} Failure reasons; empty means the gate passed.
 */
export function report(input) {
	const { label, metrics: m, leadCardWords, oracle, dirty, corpusSize } = input;
	const n = m.n;

	console.log(`\n[2/4] ORACLE (diagnostic): selection given the answer-bearing chunk...`);
	console.log(
		`    selection quality: ${pct(oracle.hit, oracle.pairs)} over ${oracle.pairs} pairs  (NOT the feature's score)`
	);

	console.log(`\n[3/4] SHIPPED (${label}): embed -> search -> cards[0] -> the rendered answer...`);
	console.log(`    the rendered short answer contains it   ${pct(m.answered, n)}   <- THE GATE`);
	console.log(`    after tapping More detail               ${pct(m.expanded, n)}`);
	console.log(
		`    the ${leadCardWords}-word lead card contained it     ${pct(m.baseline, n)}   <- the floor it must beat`
	);
	console.log(`    reachable ceiling (in SOME card)        ${pct(m.inTopK, n)}`);
	console.log(`    right answer buried under a wrong one   ${pct(m.buriedWrong, n)}`);
	console.log(
		`    bound if card choice were perfect       ${pct(m.bestCardAnswered, n)}   <- the selector lever`
	);

	// The two rates alone cannot say whether the margin is real: the queries both surfaces get right, and the
	// ones both get wrong, carry no information about which is better. Only the disagreements do.
	const p = mcnemarExactP(m.answerOnly, m.cardOnly);
	console.log(
		`    disagreements: answer ${m.answerOnly} / card ${m.cardOnly}   McNemar p=${p.toFixed(4)}`
	);

	// EQUAL BUDGET. The bar above compares a ~56-word extract against a 120-word block, so the longer surface
	// is favoured by construction and cannot tell a bad selector from a shorter one. These two hold the word
	// count fixed at whatever the answer rendered, leaving only WHICH words as the difference.
	console.log(`\n    at equal length (the same word count the answer rendered):`);
	console.log(
		`      selection vs a head window of the same card   ${pct(m.answered, n)} vs ${pct(m.headSameCard, n)}`
	);
	console.log(
		`      selection vs the lead card truncated          ${pct(m.answered, n)} vs ${pct(m.headLeadCard, n)}`
	);

	const lengths = [...m.lengths].sort((a, b) => a - b);
	const at = (/** @type {number} */ f) => lengths[Math.floor(lengths.length * f)] ?? 0;
	const overCard = lengths.filter((w) => w > leadCardWords).length;
	console.log(
		`    length: median ${at(0.5)}  p90 ${at(0.9)}  max ${lengths[lengths.length - 1] ?? 0}`
	);
	console.log(
		`    longer than the card it replaces: ${overCard} (${pct(overCard, lengths.length)})`
	);

	console.log(`\n[4/4] Scanning selected answers over the whole corpus...`);
	console.log(`    chunks scanned: ${corpusSize}    carrying junk: ${dirty.length}`);
	for (const d of dirty.slice(0, 10)) console.log(`      ${d.id}: ${d.label} -> ${d.sample}`);

	/** @type {string[]} */
	const failures = [];
	// Two conditions, because "positive" and "real" are different claims. The concordant pairs cancel, so
	// (answered - baseline) IS (answerOnly - cardOnly): the first check is direction, the second is whether
	// the margin survives the sample size. Raised S79 after the online path passed the direction-only bar by
	// a single query out of 135 - a margin that is indistinguishable from a coin flip.
	if (m.answerOnly <= m.cardOnly) {
		failures.push(
			`the short answer (${pct(m.answered, n)}) does not beat the ${leadCardWords}-word card it replaces (${pct(m.baseline, n)})`
		);
	} else if (p >= ALPHA) {
		failures.push(
			`the short answer beats the card on only ${m.answerOnly} queries against ${m.cardOnly} (p=${p.toFixed(4)}); ` +
				`at n=${n} that is not distinguishable from chance`
		);
	}
	// A "short" answer longer than the card it replaced has inverted its own premise.
	if (overCard > 0)
		failures.push(`${overCard} answers are longer than the ${leadCardWords}-word card`);
	if (dirty.length > 0) failures.push(`${dirty.length} chunks carry junk in the selected answer`);

	console.log('\n' + '='.repeat(66));
	if (failures.length > 0) {
		console.log('GATE FAILED:');
		for (const f of failures) console.log(`  - ${f}`);
		return failures;
	}
	console.log('GATE PASSED');
	return [];
}
