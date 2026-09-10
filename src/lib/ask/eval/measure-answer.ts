import type { Corpus } from '$lib/corpus';
import { search, toResultCards } from '$lib/corpus';
import { filterByMinScore } from '../threshold';
import { toExtractiveAnswer } from '../answer/answer-view';
import { stripHeadingEcho } from '../answer/heading-echo';
import { selectAnswer } from '../answer/select-answer';

/** One benchmark query. Only entries carrying BOTH a sourceId and an answerSnippet can be scored. */
export type AnswerEvalItem = {
	query: string;
	sourceId?: string;
	answerSnippet?: string;
	/**
	 * Further passages that ALSO genuinely answer this query. Most questions in a benefits corpus have more
	 * than one right answer - a comprehensive guide and a specific page both cover them - and crediting only
	 * the first-authored snippet scores a correct answer as a miss.
	 *
	 * Answer-gate only. The retrieval eval keeps its own ground truth and its calibrated floor: widening
	 * what counts as a hit there would LOWER a gate that was tuned against the narrower definition.
	 */
	altAnswers?: { sourceId: string; answerSnippet: string }[];
};

/** What one run of the shipped answer path produced, counted over the scoreable queries. */
export type AnswerMetrics = {
	/** Scoreable queries - the denominator every rate below is reported against. */
	n: number;
	/** The rendered SHORT answer contained the snippet. This is the number the gate turns on. */
	answered: number;
	/** The fuller passage contained it - what tapping "More detail" buys. */
	expanded: number;
	/** The lead card's first `leadCardWords` words contained it: the surface the answer replaces. */
	baseline: number;
	/** It was in SOME retrieved card - the ceiling selection could reach without better retrieval. */
	inTopK: number;
	/** It was in a LATER card while the short answer missed: retrieval found it, selection did not. */
	buriedWrong: number;
	/**
	 * The bound on card choice: some RETRIEVED card holds the answer and selecting on that card surfaces
	 * it. The only thing between `answered` and this number is which card gets picked, so the gap is
	 * exactly what a better selector could buy without touching retrieval. Counted over retrieved,
	 * above-cutoff cards only - a bound drawn from the whole corpus would promise gains re-ranking cannot
	 * deliver.
	 */
	bestCardAnswered: number;
	/** Queries the answer won and the lead card lost. */
	answerOnly: number;
	/** Queries the lead card won and the answer lost. */
	cardOnly: number;
	/**
	 * EQUAL BUDGET, same card: the first `wordCount(answer.text)` words of the passage the answer was cut
	 * from. `answered` beating this is the only clean evidence that CHOOSING the words is worth anything,
	 * because the coverage bar compares a short extract against a block twice its length and so favours the
	 * longer surface by construction.
	 */
	headSameCard: number;
	/** EQUAL BUDGET, lead card: the naive alternative of keeping the lead card and truncating it. */
	headLeadCard: number;
	/** Word count of each rendered short answer, in query order. Empty entries are not recorded. */
	lengths: number[];
};

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * McNemar's exact two-sided p-value for two surfaces scored on the SAME queries.
 *
 * Only the queries where the two disagree carry information - the ones both got right, or both got wrong,
 * say nothing about which is better. Under the null hypothesis that neither surface is favoured, each
 * disagreement is a fair coin, so the count on one side is Binomial(b + c, 0.5).
 *
 * This is what lets the gate demand a REAL improvement without inventing a threshold. Comparing two rates
 * and requiring "5 percentage points better" would be a number chosen by whoever wrote the gate; this
 * derives the bar from the data and the sample size.
 *
 * @param b Queries the first surface won and the second lost.
 * @param c Queries the second surface won and the first lost.
 * @returns The two-sided p-value, clamped to 1. Returns 1 when the surfaces never disagree - no evidence.
 */
export function mcnemarExactP(b: number, c: number): number {
	const n = b + c;
	if (n === 0) return 1;
	const k = Math.max(b, c);
	// Iterative PMF: pmf(0) = 0.5^n, pmf(i) = pmf(i-1) * (n - i + 1) / i. Avoids building a factorial that
	// overflows well before n reaches the benchmark's size.
	let pmf = Math.pow(0.5, n);
	let tail = 0;
	for (let i = 0; i <= n; i++) {
		if (i >= k) tail += pmf;
		pmf = (pmf * (n - i)) / (i + 1);
	}
	return Math.min(1, 2 * tail);
}

/**
 * Measure the shipped answer path end to end: embed -> search -> minScore -> cards -> the rendered answer.
 *
 * This runs the REAL pipeline rather than pairing each query to the chunk that holds its answer. An earlier
 * gate did the latter and reported 86.7%; measured through retrieval the same feature scored 24.4%, which is
 * worse than the lead card it replaced. A gate that bypasses the pipeline it guards measures intentions.
 *
 * The caller supplies `embed`, which is what makes this usable on both delivery paths: the on-device path
 * passes a local MiniLM extractor, and the online path passes a closure that prepends bge's instruction
 * prefix and calls the real Workers AI serving. Prefix policy belongs to the caller, never here - the same
 * split the build worker already uses, where passages go verbatim and queries carry the prefix.
 *
 * @param input.corpus The decoded corpus to search - the SAME artifact the target path serves from.
 * @param input.queries The benchmark set; entries without ground truth are skipped, not counted as misses.
 * @param input.embed Turns a query into a vector of `corpus.dim` length.
 * @param input.minScore The display cutoff the target path applies before rendering.
 * @param input.k Retrieval depth.
 * @param input.leadCardWords The lead card's word cap - the window `baseline` is read from.
 * @returns The counters above. Every rate is caller-computed against `n`, so no rate can quietly use a
 *   different denominator than the one reported.
 */
export async function measureAnswers(input: {
	corpus: Corpus;
	queries: AnswerEvalItem[];
	embed: (text: string) => Promise<Float32Array>;
	minScore: number;
	k: number;
	leadCardWords: number;
}): Promise<AnswerMetrics> {
	const { corpus, queries, embed, minScore, k, leadCardWords } = input;
	const scoreable = queries.filter((q) => q.sourceId && q.answerSnippet);

	const metrics: AnswerMetrics = {
		n: scoreable.length,
		answered: 0,
		expanded: 0,
		baseline: 0,
		inTopK: 0,
		buriedWrong: 0,
		bestCardAnswered: 0,
		answerOnly: 0,
		cardOnly: 0,
		headSameCard: 0,
		headLeadCard: 0,
		lengths: []
	};

	for (const q of scoreable) {
		// Every accepted phrasing of the answer. Applied identically to the answer, the passage, the lead-card
		// baseline and the reachable set, so no surface is scored by a different rule than the one it is
		// compared against.
		const needles = [q.answerSnippet ?? '', ...(q.altAnswers ?? []).map((a) => a.answerSnippet)]
			.map(normalize)
			.filter((n) => n !== '');
		const holds = (text: string) => {
			const hay = normalize(text);
			return needles.some((n) => hay.includes(n));
		};
		const vec = await embed(q.query);
		const cards = toResultCards(filterByMinScore(search(vec, corpus, k), minScore));
		const top = cards[0];
		if (top === undefined) continue;

		const answer = toExtractiveAnswer(cards, q.query);
		if (answer === undefined) continue;

		const budget = wordCount(answer.text);
		metrics.lengths.push(budget);
		const head = (text: string) => text.split(/\s+/).slice(0, budget).join(' ');
		// The passage the answer was cut from, and the lead card's text - both trimmed to the SAME number of
		// words the answer actually rendered, so length cannot decide the comparison.
		if (holds(head(answer.passage))) metrics.headSameCard++;
		if (holds(head(top.excerpt))) metrics.headLeadCard++;

		const hit = holds(answer.text);
		if (hit) metrics.answered++;
		if (holds(answer.passage)) metrics.expanded++;

		// The card's own display window, not its whole excerpt: the bar has to be what a reader actually saw.
		const shown = top.excerpt.split(/\s+/).slice(0, leadCardWords).join(' ');
		const cardHit = holds(shown);
		if (cardHit) metrics.baseline++;
		if (hit && !cardHit) metrics.answerOnly++;
		if (cardHit && !hit) metrics.cardOnly++;

		const at = cards.findIndex((c) => holds(c.excerpt));
		if (at >= 0) metrics.inTopK++;
		if (at > 0 && !hit) metrics.buriedWrong++;

		// Apply the SAME render the shipped answer uses, to each card that holds the answer. Any one of them
		// surfacing it means perfect card choice would have answered, so this is the true upper bound.
		const reachable = cards.some((card) => {
			if (!holds(card.excerpt)) return false;
			return holds(selectAnswer(stripHeadingEcho(card.excerpt, card.section), q.query));
		});
		if (reachable) metrics.bestCardAnswered++;
	}

	return metrics;
}
