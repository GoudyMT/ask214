import { describe, it, expect, vi, afterEach } from 'vitest';
import { report } from './answer-gate-core.mjs';
import type { AnswerMetrics } from '../src/lib/ask/eval/measure-answer';

// `report` is the function that decides ship / no-ship, and it was the only link in the chain with no test.
// `mcnemarExactP` and `evaluateBar` are well covered next door; what was uncovered is the COMPOSITION - which
// metric feeds which bar, which bar demands significance, and whether anything at all can fail on absolute
// quality. It could not: probed with a collapsed run it printed GATE PASSED at 0.7% answered, decided by
// seven discordant queries out of 135.
const N = 135;

/** A healthy run, matching the shape measured on the online path. Override one field per test. */
function metrics(over: Partial<AnswerMetrics> = {}): AnswerMetrics {
	return {
		n: N,
		answered: 68,
		expanded: 84,
		baseline: 69,
		inTopK: 115,
		buriedWrong: 27,
		bestCardAnswered: 100,
		experienceVsCard: { aOnly: 26, bOnly: 11 },
		tier1VsHead: { aOnly: 26, bOnly: 15 },
		tier1VsCard: { aOnly: 18, bOnly: 19 },
		headSameCard: 67,
		headLeadCard: 57,
		lengths: Array.from({ length: N }, () => 56),
		...over
	};
}

// Floors belong to the delivery path, not to this file - these are the online path's, used here only
// because the healthy fixture above is an online run. The tests are about the MECHANISM: that a floor
// breach fails the gate at all.
const FLOORS = { answered: 0.48, expanded: 0.6, inTopK: 0.83, rendered: 0.95 };

function run(over: Partial<AnswerMetrics> = {}) {
	return report({
		label: 'test',
		metrics: metrics(over),
		leadCardWords: 120,
		floors: FLOORS,
		oracle: { hit: 104, pairs: N },
		dirty: [],
		corpusSize: 1878
	});
}

// The report is a wall of console output; silence it so a failure message is readable.
const logged: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
	logged.push(args.map(String).join(' '));
});
afterEach(() => (logged.length = 0));

describe('report', () => {
	it('passes a healthy run', () => {
		expect(run()).toEqual([]);
	});

	// THE defect this file exists for. The paired bars discard every query the two surfaces agree on, so a
	// regression that hurts BOTH equally moves no bar - it only lowers the printed rate, which nothing read.
	it('fails when coverage collapses even though both bars still win', () => {
		const failures = run({
			answered: 1,
			expanded: 6,
			baseline: 0,
			inTopK: 6,
			headLeadCard: 0,
			experienceVsCard: { aOnly: 6, bOnly: 0 },
			tier1VsHead: { aOnly: 1, bOnly: 0 },
			lengths: Array.from({ length: N }, () => 45)
		});
		expect(failures.length).toBeGreaterThan(0);
		expect(failures.join(' ')).toMatch(/floor/i);
	});

	it('fails when the short answer alone falls below its floor', () => {
		expect(run({ answered: 40 }).join(' ')).toMatch(/short answer/i);
	});

	it('fails when the two-tier experience falls below its floor', () => {
		expect(run({ expanded: 50 }).join(' ')).toMatch(/two-tier/i);
	});

	// Retrieval reachability is the one input the answer layer cannot fix. If the corpus or the ranker
	// regresses, every surface loses together and the paired bars stay silent.
	it('fails when retrieval reachability falls below its floor', () => {
		expect(run({ inTopK: 60 }).join(' ')).toMatch(/reachab/i);
	});

	// A run where most queries render NOTHING can still post healthy-looking rates, because every rate is
	// over `n` while the length stats are over the answers that actually rendered.
	it('fails when most queries render no answer at all', () => {
		expect(run({ lengths: Array.from({ length: 40 }, () => 56) }).join(' ')).toMatch(/render/i);
	});

	it('discloses how many answers actually rendered', () => {
		run();
		expect(logged.join('\n')).toMatch(/answers rendered:\s*135 of 135/);
	});

	// Pre-existing conditions, kept honest by the same test file now that one exists.
	it('fails when an answer is longer than the card it replaces', () => {
		expect(run({ lengths: [...Array.from({ length: N - 1 }, () => 56), 200] }).join(' ')).toMatch(
			/longer than/i
		);
	});

	// The tier-1 guard is the only paired bar left, and it is direction-only by design: demanding
	// significance of a regression guard makes it unfalsifiable when the true effect is small, so it could
	// only ever fail. See evaluateBar.
	it('fails when tier 1 falls below the lead card at equal length', () => {
		expect(run({ tier1VsHead: { aOnly: 2, bOnly: 8 } }).join(' ')).toMatch(/fallen BELOW/i);
	});

	it('passes the guard on direction alone, without demanding significance', () => {
		expect(run({ tier1VsHead: { aOnly: 3, bOnly: 2 } })).toEqual([]);
	});

	// RETIRED 2026-09-13, and pinned so it cannot be reinstated without someone reading why. The bar "the
	// two-tier answer must beat the 120-word lead card" stopped being a comparison when the answer block was
	// reverted to render that card's own passage: measured, the two surfaces disagree on 2 of 135 queries.
	// The reversal was made because the previous surface shipped misleading text on 28 of 135 against the
	// card's 20, a failure substring containment cannot see - it rose while harm rose with it. Re-adding
	// this bar would gate the feature on a comparison with itself.
	it('no longer gates on the two-tier comparison, whichever way it falls', () => {
		expect(run({ experienceVsCard: { aOnly: 3, bOnly: 9 } })).toEqual([]);
		expect(run({ experienceVsCard: { aOnly: 0, bOnly: 0 } })).toEqual([]);
	});
});
