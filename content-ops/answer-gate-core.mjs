// Shared by the two answer gates (`pnpm answer-gate` on-device, `pnpm answer-gate:bge` online). Everything
// here is path-INDEPENDENT: the oracle diagnostic, the junk scan, and the report + pass/fail decision. Only
// the corpus artifact, the embedder, and the display cutoff differ between paths, and those live in the two
// entry scripts. One copy of the bar means the two gates cannot drift into judging the same feature
// differently - which is the failure this split exists to prevent.
import { cleanExcerpt } from '../src/lib/corpus/clean-excerpt.ts';
import { stripHeadingEcho } from '../src/lib/ask/answer/heading-echo.ts';
import { selectAnswer } from '../src/lib/ask/answer/select-answer.ts';
import { violatedProperties } from '../src/lib/content-ops/corpus/answer-properties.ts';
import { mcnemarExactP, evaluateBar } from '../src/lib/ask/eval/measure-answer.ts';

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
/** @typedef {{ aOnly: number; bOnly: number }} Discordant */
/** @typedef {{ n: number; answered: number; expanded: number; baseline: number; inTopK: number; buriedWrong: number; bestCardAnswered: number; experienceVsCard: Discordant; tier1VsHead: Discordant; tier1VsCard: Discordant; headSameCard: number; headLeadCard: number; lengths: number[] }} AnswerMetrics */

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
		if (norm(selectAnswer(bodyOf(chunk))).includes(needle)) hit++;
	}
	return { hit, pairs };
}

/**
 * Junk carried into a SELECTED answer, over every chunk rather than only the benchmarked ones. The
 * benchmark touches a few hundred chunks; furniture can sit anywhere in 1992.
 *
 * Two kinds of check run here. `JUNK` names specific verified strings, which only protects against sources
 * already seen. `ANSWER_PROPERTIES` describes the SHAPES that make an answer unsafe to read alone, so a
 * source nobody has ingested yet is gated by the same rules - that is what stops this list growing by one
 * entry per new guide.
 *
 * @param {{ chunks: GateChunk[] }} corpus
 * @returns {{ id: string; label: string; sample: string }[]}
 */
export function scanJunk(corpus) {
	const dirty = [];
	for (const chunk of corpus.chunks) {
		const out = selectAnswer(bodyOf(chunk));
		for (const { pattern, label } of JUNK) {
			if (pattern.test(out)) dirty.push({ id: chunk.id, label, sample: out.slice(0, 90) });
		}
		for (const id of violatedProperties(out, chunk)) {
			dirty.push({ id: chunk.id, label: 'property ' + id, sample: out.slice(0, 90) });
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
 * @param {{ label: string; metrics: AnswerMetrics; leadCardWords: number; floors: { answered: number; expanded: number; inTopK: number; rendered: number }; oracle: { hit: number; pairs: number }; dirty: { id: string; label: string; sample: string }[]; corpusSize: number }} input
 * @returns {string[]} Failure reasons; empty means the gate passed.
 */
export function report(input) {
	const { label, metrics: m, leadCardWords, floors, oracle, dirty, corpusSize } = input;
	const n = m.n;

	console.log(`\n[2/4] ORACLE (diagnostic): selection given the answer-bearing chunk...`);
	console.log(
		`    selection quality: ${pct(oracle.hit, oracle.pairs)} over ${oracle.pairs} pairs  (NOT the feature's score)`
	);

	console.log(`\n[3/4] SHIPPED (${label}): embed -> search -> cards[0] -> the rendered answer...`);
	// Labels name what each number is actually WIRED to, and nothing else. A label describing a pass
	// condition the code does not implement was a finding in its own right once; the only bar left is the
	// direction-only tier-1 guard, everything else here is a floor or context.
	console.log(
		`    the rendered short answer contains it   ${pct(m.answered, n)}   <- floor + the tier-1 guard`
	);
	console.log(`    after tapping More detail               ${pct(m.expanded, n)}   <- floor`);
	console.log(
		`    the ${leadCardWords}-word lead card contained it     ${pct(m.baseline, n)}   <- the surface tier 1 now renders`
	);
	console.log(`    reachable ceiling (in SOME card)        ${pct(m.inTopK, n)}`);
	console.log(`    right answer buried under a wrong one   ${pct(m.buriedWrong, n)}`);
	console.log(
		`    bound if card choice were perfect       ${pct(m.bestCardAnswered, n)}   <- the selector lever`
	);

	// Two paired comparisons, each against the FAIREST available alternative, because the feature is two-tier
	// and the surface it replaced is not. Rates alone cannot say whether a margin is real; only the queries
	// where the two surfaces disagree carry that information.
	const pExp = mcnemarExactP(m.experienceVsCard.aOnly, m.experienceVsCard.bOnly);
	const pT1 = mcnemarExactP(m.tier1VsHead.aOnly, m.tier1VsHead.bOnly);
	const pOld = mcnemarExactP(m.tier1VsCard.aOnly, m.tier1VsCard.bOnly);
	console.log(`\n    paired comparisons (disagreements only):`);
	console.log(
		`      context  experience vs the ${leadCardWords}-word card   ${m.experienceVsCard.aOnly} / ${m.experienceVsCard.bOnly}   p=${pExp.toFixed(4)}  (bar retired - same surface)`
	);
	console.log(
		`      THE GUARD  tier 1 vs the lead card at equal length   ${m.tier1VsHead.aOnly} / ${m.tier1VsHead.bOnly}   p=${pT1.toFixed(4)}  (direction only)`
	);
	console.log(
		`      context  tier 1 alone vs the full card             ${m.tier1VsCard.aOnly} / ${m.tier1VsCard.bOnly}   p=${pOld.toFixed(4)}`
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
	// Disclosed because every rate above is over `n` while these length stats are over the answers that
	// actually RENDERED. A run where most queries produce nothing still posts rates against 135, and
	// nothing on screen said the two denominators differed.
	console.log(`    answers rendered: ${lengths.length} of ${n}`);
	console.log(
		`    length: median ${at(0.5)}  p90 ${at(0.9)}  max ${lengths[lengths.length - 1] ?? 0}`
	);
	console.log(
		`    longer than the card it replaces: ${overCard} (${pct(overCard, lengths.length)} of rendered)`
	);

	console.log(`\n[4/4] Scanning selected answers over the whole corpus...`);
	console.log(`    chunks scanned: ${corpusSize}    carrying junk: ${dirty.length}`);
	for (const d of dirty.slice(0, 10)) console.log(`      ${d.id}: ${d.label} -> ${d.sample}`);

	/** @type {string[]} */
	const failures = [];
	// TWO bars, each against the fairest available alternative, and each needing BOTH direction and
	// significance - "positive" and "real" are different claims. The concordant pairs cancel, so a rate
	// difference IS the discordant difference; McNemar then says whether it survives the sample size.
	//
	// Why not tier 1 against the full card: that surface has no second tier, so a ~56-word extract loses to a
	// 120-word block on "contains the answer somewhere" almost by construction. Measured: coverage rises
	// smoothly with length, ~0.2pp per word, with no knee. The bar moved to the two-tier EXPERIENCE once the
	// feature was ahead on its own terms (62.2% vs 51.1% online); it was deliberately NOT moved while the
	// feature was behind, which would have been moving the goalposts. Tier 1 alone stays reported above.
	//
	// The second bar exists so tier 1 cannot quietly rot while tier 2 carries the gate: it holds length fixed
	// at whatever tier 1 rendered and asks only whether the right WORDS were chosen.
	// RETIRED 2026-09-13: the bar "the two-tier answer must beat the 120-word lead card". It is not relaxed,
	// it is no longer a comparison. The answer block now renders that card's own passage by design, so the two
	// surfaces agree on 133 of 135 queries and the test compares a thing to itself - measured 2 disagreements,
	// p=0.5000, which no implementation could ever pass.
	//
	// Why the surfaces converged: choosing the answer across the retrieved set won +8.1pp here while shipping
	// misleading text on 28 of 135 queries against the lead card's 20, judged blind by readers who saw only
	// what a user sees. 17 of those 28 were questions the card had answered safely. Substring containment
	// cannot see that failure - it ROSE while harm rose with it - which is the whole reason this bar could not
	// be the thing that governs the feature.
	//
	// The real quality gate is now the blind paired harm comparison, which needs human-judged runs and cannot
	// live in CI. It is specified in docs/superpowers/specs/2026-09-13-corpus-shape-cycle-design.md section 7.
	// What remains HERE is regression protection: absolute floors, the junk scan, the length ceiling, and the
	// direction-only tier-1 guard below, which still discriminates because the answer has its heading echo
	// stripped while the raw card window spends its first words repeating the section title.
	const bars = [
		{
			// A regression GUARD, so direction only - see evaluateBar.
			label: 'tier 1 at equal length',
			regressed: `tier 1 (${pct(m.answered, n)}) has fallen BELOW the lead card at the same length (${pct(m.headLeadCard, n)})`,
			d: m.tier1VsHead,
			requireSignificance: false
		}
	];
	for (const bar of bars) {
		const v = evaluateBar(bar.d, bar.requireSignificance, ALPHA);
		if (v.reason === 'direction') failures.push(bar.regressed);
		else if (v.reason === 'significance') {
			failures.push(
				`${bar.label} wins only ${bar.d.aOnly} of the ${bar.d.aOnly + bar.d.bOnly} disagreements ` +
					`(p=${v.p.toFixed(4)}); at n=${n} that is not distinguishable from chance`
			);
		}
	}
	// ABSOLUTE FLOORS, fail-closed. The paired bars above ask only whether the feature beats the surface it
	// replaced, and they DISCARD every query the two surfaces agree on - so a regression that hurts both
	// equally moves no bar at all. Probed with a collapsed run, this gate printed GATE PASSED at 0.7%
	// answered on the strength of seven discordant queries out of 135.
	//
	// The caller supplies them because the two delivery paths score differently - a different model, a
	// different cutoff - so one set of numbers baked in here would be wrong for whichever path did not
	// produce it.
	//
	// These are REGRESSION floors, not a quality bar. Each is the rate measured on its own path, less
	// roughly two queries of slack at the benchmark's current size. They are deliberately NOT the spec's
	// locked 85% / 91%, which this feature does not meet - closing that gap is a product decision, not
	// something a script gets to quietly redefine. Raise a floor when the feature genuinely improves;
	// never lower one to make a run pass. Same rule the retrieval eval states: climb the escalation
	// ladder, never lower the gate.
	/** @type {{ what: string; value: number; floor: number }[]} */
	const floorChecks = [
		{ what: 'the short answer', value: m.answered, floor: floors.answered },
		{ what: 'the two-tier answer', value: m.expanded, floor: floors.expanded },
		{ what: 'retrieval reachability', value: m.inTopK, floor: floors.inTopK },
		{ what: 'answers rendered', value: lengths.length, floor: floors.rendered }
	];
	for (const { what, value, floor } of floorChecks) {
		if (value / n < floor) {
			failures.push(
				`${what} is ${pct(value, n)}, below the ${(floor * 100).toFixed(1)}% regression floor`
			);
		}
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
