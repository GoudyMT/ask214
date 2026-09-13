import { describe, it, expect } from 'vitest';
import type { Corpus, CorpusChunk } from '$lib/corpus';
import { measureAnswers, mcnemarExactP, evaluateBar, type AnswerEvalItem } from './measure-answer';

// A 2-dimension corpus so a hit's cosine is controllable exactly: the query is [1, 0], so an embedding of
// [1, 0] scores 1.0, [0.8, 0.6] scores 0.8, and [0, 1] scores 0. That makes the minScore filter and the
// card ORDER testable without depending on a real model.
const QUERY_VEC = Float32Array.from([1, 0]);
const embed = async () => QUERY_VEC;

function chunk(over: Partial<CorpusChunk> & { id: string; text: string }): CorpusChunk {
	return {
		sourceId: 'tap_va101',
		sourceTitle: 'TAP - VA Benefits Briefing',
		url: 'https://www.tapevents.mil/resources/documents',
		tags: [],
		...over
	};
}

function corpusOf(pairs: [CorpusChunk, [number, number]][]): Corpus {
	return {
		version: '1.0',
		dim: 2,
		modelId: 'test',
		chunks: pairs.map(([c]) => c),
		embeddings: pairs.map(([, e]) => Float32Array.from(e))
	};
}

// Sized against the selector's OWN budget (45-word target, 1.5x ceiling), not by eye. The query's terms are
// in the opening sentences so the selected run lands at the top, and the answer sentence sits ~80 words in -
// past the ceiling - so it is reachable only by expanding. A shorter body would be returned whole and every
// assertion below would pass against a function that did no selection at all.
const LONG_BODY =
	'Vet Centers provide readjustment counseling to combat veterans and their families. ' +
	'Counseling is provided at no cost to the veteran or to any family member. ' +
	'Staff are frequently veterans themselves and many served in combat theaters. ' +
	'Services include individual counseling, group counseling, and family counseling sessions. ' +
	'Referrals to other VA facilities are made when a need falls outside the center scope. ' +
	'Locations are listed in the directory and many operate outside normal business hours. ' +
	'Eligibility extends to members who served in any combat theater or area of hostility. ' +
	// Filler that pushes the snippet past the 120-word tier-1 budget on purpose. Several tests here turn on
	// the snippet being reachable in the PASSAGE but not in the ANSWER, and a body inside the budget is
	// returned whole - which would make those tests pass against an implementation that truncates nothing.
	'Counselors coordinate with community providers when a veteran needs care the center cannot deliver. ' +
	'Group sessions run on a weekly schedule and are open to family members of enrolled veterans. ' +
	'Staff can explain how readjustment counseling differs from the care provided at a medical center. ' +
	'The magic phrase is that bereavement counseling is available to surviving family members.';

const SNIPPET = 'bereavement counseling is available to surviving family members';

// The snippet sits past a 10-word card window but inside the answer's opening run. The answer is emitted
// from the passage opening, so a fixture hiding the snippet in the tail would test nothing.
const OPENING_BODY =
	'Vet Centers serve combat veterans and their families nationwide. ' +
	`Additionally ${SNIPPET} at no cost. ` +
	'Staff are frequently veterans themselves and many served in combat theaters.';

const base = {
	embed,
	minScore: 0.5,
	k: 5,
	leadCardWords: 120
};

describe('measureAnswers', () => {
	// The denominator is the gate's honesty: a query with no ground truth cannot be scored, and counting it
	// as a miss would understate every rate in the report.
	it('counts only queries carrying both a sourceId and an answerSnippet', async () => {
		const corpus = corpusOf([[chunk({ id: 'a', text: LONG_BODY }), [1, 0]]]);
		const queries: AnswerEvalItem[] = [
			{ query: 'vet center counseling', sourceId: 'tap_va101', answerSnippet: SNIPPET },
			{ query: 'no ground truth here' },
			{ query: 'snippet but no source', answerSnippet: SNIPPET }
		];
		const m = await measureAnswers({ ...base, corpus, queries });
		expect(m.n).toBe(1);
	});

	it('counts an answer as answered when the rendered short answer contains the snippet', async () => {
		const short = chunk({ id: 'a', text: `${SNIPPET}. Vet Centers also offer referrals.` });
		const corpus = corpusOf([[short, [1, 0]]]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [{ query: 'bereavement counseling', sourceId: 'tap_va101', answerSnippet: SNIPPET }]
		});
		expect(m.answered).toBe(1);
		expect(m.expanded).toBe(1);
	});

	// Tier 2's whole reason to exist: the short answer misses, the fuller passage carries it. If these two
	// counters cannot diverge, the gate cannot show what expanding buys.
	it('counts expanded without answered when the snippet is only in the fuller passage', async () => {
		const corpus = corpusOf([[chunk({ id: 'a', text: LONG_BODY }), [1, 0]]]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [
				{ query: 'readjustment counseling combat', sourceId: 'tap_va101', answerSnippet: SNIPPET }
			]
		});
		expect(m.answered).toBe(0);
		expect(m.expanded).toBe(1);
	});

	// The baseline IS the bar the gate compares against, so its window has to be the card's real one. Reading
	// the whole excerpt instead of the first N words would inflate the floor and could fail a real improvement.
	it('reads the baseline from the lead card first N words only', async () => {
		const corpus = corpusOf([[chunk({ id: 'a', text: OPENING_BODY }), [1, 0]]]);
		const queries: AnswerEvalItem[] = [
			{ query: 'readjustment counseling combat', sourceId: 'tap_va101', answerSnippet: SNIPPET }
		];
		const wide = await measureAnswers({ ...base, corpus, queries, leadCardWords: 120 });
		const narrow = await measureAnswers({ ...base, corpus, queries, leadCardWords: 10 });
		expect(wide.baseline).toBe(1); // the snippet sits at word 11, well inside a 120-word window
		expect(narrow.baseline).toBe(0); // and past a 10-word one
	});

	// The measurement that justified choosing across the retrieved set: the answer exists, retrieval found
	// it, and a wrong card sat on top of it. A gate that cannot see this cannot show selection is the lever.
	it('counts a buried answer when the snippet is in a later card and the short answer missed', async () => {
		const wrong = chunk({ id: 'wrong', text: 'Parking at the facility is limited to two hours.' });
		const right = chunk({ id: 'right', text: `${SNIPPET}. Referrals are made as needed.` });
		const corpus = corpusOf([
			[wrong, [1, 0]], // scores 1.0 - ranks first
			[right, [0.8, 0.6]] // scores 0.8 - ranks second
		]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [{ query: 'parking limited', sourceId: 'tap_va101', answerSnippet: SNIPPET }]
		});
		expect(m.inTopK).toBe(1);
		expect(m.buriedWrong).toBe(1);
		expect(m.answered).toBe(0);
	});

	// The shipped path filters before it renders, so a chunk the user would never see must not be scored.
	it('drops chunks below minScore, exactly as the shipped path does', async () => {
		const corpus = corpusOf([[chunk({ id: 'a', text: `${SNIPPET}.` }), [0, 1]]]); // cosine 0
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [{ query: 'bereavement', sourceId: 'tap_va101', answerSnippet: SNIPPET }]
		});
		expect(m.n).toBe(1); // still in the denominator - it was answerable
		expect(m.answered).toBe(0);
		expect(m.inTopK).toBe(0);
		expect(m.lengths).toEqual([]); // nothing rendered, so nothing to measure
	});

	// The bound on the card-choice lever: retrieval found the answer and selecting on THAT card surfaces it,
	// so the only thing standing between the shipped score and this number is which card gets picked. It has
	// to be counted from the RETRIEVED set, not the whole corpus - a bound that assumes perfect retrieval
	// would overstate what better selection alone can buy.
	it('counts the best-card bound when a later card would have answered', async () => {
		const wrong = chunk({ id: 'wrong', text: 'Parking at the facility is limited to two hours.' });
		const right = chunk({ id: 'right', text: `${SNIPPET}. Referrals are made as needed.` });
		const corpus = corpusOf([
			[wrong, [1, 0]],
			[right, [0.8, 0.6]]
		]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [{ query: 'parking limited', sourceId: 'tap_va101', answerSnippet: SNIPPET }]
		});
		expect(m.answered).toBe(0); // the wrong card was chosen
		expect(m.bestCardAnswered).toBe(1); // choosing the other retrieved card would have answered
	});

	// A card below the cutoff is never shown, so it cannot be part of a bound on choosing between shown
	// cards. Counting it would promise a gain that no amount of re-ranking could deliver.
	it('excludes cards below minScore from the best-card bound', async () => {
		const wrong = chunk({ id: 'wrong', text: 'Parking at the facility is limited to two hours.' });
		const right = chunk({ id: 'right', text: `${SNIPPET}.` });
		const corpus = corpusOf([
			[wrong, [1, 0]],
			[right, [0, 1]] // cosine 0 - filtered out before rendering
		]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [{ query: 'parking limited', sourceId: 'tap_va101', answerSnippet: SNIPPET }]
		});
		expect(m.bestCardAnswered).toBe(0);
	});

	// THE BAR. The feature is two-tier and the surface it replaced is not, so scoring tier 1 alone against a
	// 120-word block measures length, not quality. This pair is the experience - what a reader reaches after
	// one tap - against what it replaced.
	it('splits the discordant pairs for the experience against the card', async () => {
		const corpus = corpusOf([[chunk({ id: 'a', text: LONG_BODY }), [1, 0]]]);
		// The answer sentence sits past the collapsed window but inside the full passage, and a 10-word card
		// window cannot reach it either: the experience wins, the card does not.
		const m = await measureAnswers({
			...base,
			corpus,
			leadCardWords: 10,
			queries: [
				{ query: 'readjustment counseling combat', sourceId: 'tap_va101', answerSnippet: SNIPPET }
			]
		});
		expect(m.experienceVsCard.aOnly).toBe(1);
		expect(m.experienceVsCard.bOnly).toBe(0);
		expect(m.answered).toBe(0); // tier 1 alone missed it - which is exactly why it must not be the bar
	});

	// The second bar, so tier 1 cannot quietly rot while tier 2 carries the gate. Length is held fixed, so
	// this tests WHICH words, not how many. Since the answer became the lead card's own opening, what still
	// separates it from a same-length head window of that card is the heading echo: the answer has it
	// stripped and spends the whole budget on content, while the raw window spends its first words repeating
	// the section title and reaches less far into the chunk.
	it('splits the discordant pairs for tier 1 against a length-matched lead card', async () => {
		const SECTION = 'What bereavement services does the Vet Center provide to surviving families';
		const lead = chunk({
			id: 'lead',
			section: SECTION,
			text: `${SECTION} Vet Centers serve combat veterans and their families at no cost to the veteran or to any family member whatsoever. ${SNIPPET}.`
		});
		const m = await measureAnswers({
			...base,
			corpus: corpusOf([[lead, [1, 0]]]),
			queries: [{ query: 'bereavement counseling', sourceId: 'tap_va101', answerSnippet: SNIPPET }]
		});
		expect(m.tier1VsHead.aOnly).toBe(1);
		expect(m.tier1VsHead.bOnly).toBe(0);
	});

	// The two rates alone cannot say whether a margin is real. These are the discordant pairs: the queries
	// where the two surfaces actually disagree, which is the only place the comparison carries information.
	it('splits the discordant pairs by which surface won', async () => {
		// The answer reaches the snippet in its opening run; a 10-word card window stops short of it.
		const answerWins = await measureAnswers({
			...base,
			corpus: corpusOf([[chunk({ id: 'a', text: OPENING_BODY }), [1, 0]]]),
			leadCardWords: 10,
			queries: [
				{ query: 'bereavement surviving family', sourceId: 'tap_va101', answerSnippet: SNIPPET }
			]
		});
		expect(answerWins.tier1VsCard.aOnly).toBe(1);
		expect(answerWins.tier1VsCard.bOnly).toBe(0);

		// The card wins in exactly one shape now that both surfaces render the lead card's opening: a
		// sentence boundary stops the answer short of the card's raw word window. Four 25-word sentences
		// pack to 100; the fifth would bust 120 so the answer stops, while the card's raw 120-word window
		// reaches into that fifth sentence and picks the snippet up.
		const sentence = (n: number) =>
			`Filler ${Array.from({ length: 23 }, () => 'word').join(' ')} ${n}.`;
		const cardWins = await measureAnswers({
			...base,
			corpus: corpusOf([
				[
					chunk({
						id: 'boundary',
						text:
							`${sentence(1)} ${sentence(2)} ${sentence(3)} ${sentence(4)} ` +
							`Bereavement counseling is available to surviving family members and this clause ` +
							`deliberately runs on past the budget for several more words here.`
					}),
					[1, 0]
				]
			]),
			leadCardWords: 120,
			queries: [
				{ query: 'readjustment counseling combat', sourceId: 'tap_va101', answerSnippet: SNIPPET }
			]
		});
		expect(cardWins.tier1VsCard.aOnly).toBe(0);
		expect(cardWins.tier1VsCard.bOnly).toBe(1);
	});

	// A question can have more than one right answer, and the corpus genuinely carries several for most of
	// the benchmark. Crediting only the first-authored snippet scores a correct answer as a miss.
	it('credits any accepted answer, not only the primary snippet', async () => {
		const corpus = corpusOf([
			[
				chunk({ id: 'a', text: 'Vet Centers are free and confidential to every combat veteran.' }),
				[1, 0]
			]
		]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [
				{
					query: 'vet center cost',
					sourceId: 'tap_va101',
					answerSnippet: 'a snippet that appears nowhere in the corpus',
					altAnswers: [{ sourceId: 'tap_va101', answerSnippet: 'free and confidential' }]
				}
			]
		});
		expect(m.answered).toBe(1);
	});

	// Provenance is part of the claim. The type demands a sourceId on every accepted answer and the metric
	// was discarding it, so the same sentence found in a DIFFERENT document scored as a hit. Measured on the
	// real benchmark, 14 of 99 accepted answers appear in more than one source - one of them in ten - and a
	// general VA hotline number sitting in a Reserve dual-pay guide does not answer a GI Bill question.
	it('does not credit an accepted answer found in a different source', async () => {
		const corpus = corpusOf([
			[
				chunk({
					id: 'a',
					sourceId: 'tap_reserve_dual_pay',
					text: 'Vet Centers are free and confidential to every combat veteran.'
				}),
				[1, 0]
			]
		]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [
				{
					query: 'vet center cost',
					sourceId: 'tap_va101',
					answerSnippet: 'a snippet that appears nowhere in the corpus',
					altAnswers: [{ sourceId: 'tap_va101', answerSnippet: 'free and confidential' }]
				}
			]
		});
		expect(m.answered).toBe(0);
		expect(m.inTopK).toBe(0);
	});

	// The floor has to be scored by the SAME rule as the thing it is the floor for. Crediting alternates on
	// one surface but not the other would hand the comparison a result the data does not support.
	it('applies the accepted answers to the lead-card baseline too', async () => {
		const corpus = corpusOf([
			[
				chunk({ id: 'a', text: 'Vet Centers are free and confidential to every combat veteran.' }),
				[1, 0]
			]
		]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [
				{
					query: 'vet center cost',
					sourceId: 'tap_va101',
					answerSnippet: 'a snippet that appears nowhere in the corpus',
					altAnswers: [{ sourceId: 'tap_va101', answerSnippet: 'free and confidential' }]
				}
			]
		});
		expect(m.baseline).toBe(1);
		expect(m.tier1VsCard.aOnly).toBe(0);
		expect(m.tier1VsCard.bOnly).toBe(0);
	});

	// headSameCard is now DEGENERATE and is kept only as a printed diagnostic, never as a bar. It compares
	// the answer against the first wordCount(answer) words of the same passage - and since the answer became
	// a whole-sentence window over that passage's opening, the two are the same text by construction. It
	// existed to show that CHOOSING words beat a head window; that mechanism was removed once it measured
	// 0.0pp on device while causing the severing this module now prevents. The gate's second bar is
	// tier1VsHead, which pairs against the LEAD card truncated and still discriminates.
	it('scores a head window of the same length on the chosen card', async () => {
		const corpus = corpusOf([[chunk({ id: 'a', text: OPENING_BODY }), [1, 0]]]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [
				{ query: 'bereavement surviving family', sourceId: 'tap_va101', answerSnippet: SNIPPET }
			]
		});
		expect(m.answered).toBe(1);
		expect(m.headSameCard).toBe(1);
	});

	// The naive alternative to this whole feature: keep the lead card and just truncate it to the same
	// length. If the feature cannot beat that, the selection is not what is buying the improvement.
	it('scores a head window of the same length on the lead card', async () => {
		const wrong = chunk({ id: 'wrong', text: 'Parking at the facility is limited to two hours.' });
		const right = chunk({ id: 'right', text: `${SNIPPET}. Referrals are made as needed.` });
		const corpus = corpusOf([
			[wrong, [1, 0]], // ranks first, holds no answer
			[right, [0.8, 0.6]]
		]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [{ query: 'bereavement counseling', sourceId: 'tap_va101', answerSnippet: SNIPPET }]
		});
		expect(m.headLeadCard).toBe(0); // truncating the lead card can never reach a later card
	});

	it('records the word count of each rendered short answer', async () => {
		const corpus = corpusOf([[chunk({ id: 'a', text: 'Vet Centers offer counseling.' }), [1, 0]]]);
		const m = await measureAnswers({
			...base,
			corpus,
			queries: [{ query: 'counseling', sourceId: 'tap_va101', answerSnippet: 'counseling' }]
		});
		expect(m.lengths).toEqual([4]);
	});
});

// The gate turns on this number, so a wrong implementation would silently pass features that are no better
// than what they replaced. Values are computed by hand from the binomial, not copied from a run.
describe('mcnemarExactP', () => {
	it('returns 1 when the two surfaces never disagree', () => {
		expect(mcnemarExactP(0, 0)).toBe(1);
	});

	// n=10 all on one side: 2 * C(10,10) * 0.5^10 = 2/1024.
	it('is decisive when every disagreement favours one side', () => {
		expect(mcnemarExactP(10, 0)).toBeCloseTo(0.001953125, 9);
	});

	// n=9, k=8: 2 * [C(9,8) + C(9,9)] * 0.5^9 = 2 * 10/512.
	it('computes the exact two-sided tail', () => {
		expect(mcnemarExactP(8, 1)).toBeCloseTo(0.0390625, 9);
	});

	// An even split carries no evidence either way; the doubled tail is clamped at 1 rather than exceeding it.
	it('clamps to 1 on an even split', () => {
		expect(mcnemarExactP(5, 5)).toBe(1);
	});

	// Direction does not change the two-sided p-value - only the gate's separate b > c check does.
	it('is symmetric in its arguments', () => {
		expect(mcnemarExactP(8, 1)).toBeCloseTo(mcnemarExactP(1, 8), 12);
	});

	// A single disagreement can never be significant: 2 * 0.5^1 = 1.
	it('never calls one disagreement significant', () => {
		expect(mcnemarExactP(1, 0)).toBe(1);
	});
});

// The gate's verdict is the one thing that must not be wrong, so it is a pure function with its own tests
// rather than inline logic in a script.
describe('evaluateBar', () => {
	const A = 0.05;

	it('passes a bar that wins its disagreements decisively', () => {
		expect(evaluateBar({ aOnly: 10, bOnly: 0 }, true, A).ok).toBe(true);
	});

	it('fails a bar whose direction is wrong, significance regardless', () => {
		const v = evaluateBar({ aOnly: 5, bOnly: 12 }, true, A);
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('direction');
	});

	// A margin that could be a coin flip is not evidence, however positive it looks.
	it('fails a significance-gated bar that is positive but not distinguishable', () => {
		const v = evaluateBar({ aOnly: 26, bOnly: 13 }, true, A);
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('significance');
	});

	// THE DIFFERENCE. A regression GUARD asks "has this rotted", not "is this proven better" - so it checks
	// direction only. Demanding significance of it made it unfalsifiable: at the observed 1.5:1 ratio it
	// would need well past 270 benchmark queries and still not clear, so it could only ever fail.
	it('passes a direction-only bar that is positive but not significant', () => {
		const v = evaluateBar({ aOnly: 27, bOnly: 18 }, false, A);
		expect(v.ok).toBe(true);
	});

	it('still fails a direction-only bar that has actually regressed', () => {
		const v = evaluateBar({ aOnly: 18, bOnly: 27 }, false, A);
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('direction');
	});

	// No disagreements means no evidence either way; a tie is not a win.
	it('fails a bar with no disagreements at all', () => {
		expect(evaluateBar({ aOnly: 0, bOnly: 0 }, false, A).ok).toBe(false);
	});
});
