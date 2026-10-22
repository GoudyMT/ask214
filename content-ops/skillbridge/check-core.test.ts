import { describe, it, expect } from 'vitest';
import { daysBetween, emptyState, runCheck } from './check-core.ts';
import type {
	CheckOutput,
	CleanListing,
	CleanOutput,
	LinksOutput,
	PipelineState,
	ProviderResult,
	PullRun,
	StateRecord
} from './types.ts';
import type { Listing } from '../../src/lib/skillbridge-finder/contract/listing.ts';

const PULL_DATE = '2026-10-21';
const LAST_PULL = '2026-10-14';
const BASELINE = '2026-01-05';
const PROVIDER = 'Example Provider One';
const OTHER_PROVIDER = 'Example Provider Two';

type Input = Parameters<typeof runCheck>[0];

function cleanRow(i: number, over: Partial<CleanListing> = {}): CleanListing {
	return {
		i,
		o: 301,
		n: 'Example Wind Services',
		p: 'Field Technician Internship',
		m: 1,
		b: [],
		ind: ['Management'],
		dib: false,
		dc: '2026-02-10',
		...over
	};
}

function published(i: number, over: Partial<Listing> = {}): Listing {
	return { ...cleanRow(i), fl: BASELINE, ...over };
}

function record(i: number, provider = PROVIDER, misses = 0, listing = published(i)): StateRecord {
	return { listing, provider, misses };
}

function stateOf(records: StateRecord[], over: Partial<PipelineState> = {}): PipelineState {
	return {
		...emptyState(),
		baselineDate: BASELINE,
		lastPullDate: LAST_PULL,
		knownOrgs: [301],
		records: Object.fromEntries(records.map((r) => [String(r.listing.i), r])),
		...over
	};
}

function provider(name: string, ids: number[], complete = true): ProviderResult {
	return { name, total: ids.length, ids, complete, cappedQueries: 0 };
}

function pullOf(providers: ProviderResult[], over: Partial<PullRun> = {}): PullRun {
	const sum = providers.reduce((n, p) => n + p.total, 0);
	return {
		mode: 'weekly',
		pullDate: PULL_DATE,
		totalN: sum,
		totalPositions: sum,
		filtersProviders: providers.map((p) => p.name),
		rows: [],
		providers,
		sumOfTotals: sum,
		sumGate: true,
		dormantSwept: false,
		nextMode: 'weekly',
		requests: 10,
		elapsedMs: 1000,
		...over
	};
}

function cleaned(listings: CleanListing[], aliases: [number, number][] = []): CleanOutput {
	return { listings, aliases, quarantine: [], dropped: {}, overseas: [] };
}

const NO_LINKS: LinksOutput = { byOrg: [], pinned: [], requests: 0 };

function run(over: Partial<Input>): CheckOutput {
	return runCheck({
		state: stateOf([]),
		pull: pullOf([]),
		clean: cleaned([]),
		links: NO_LINKS,
		pullDate: PULL_DATE,
		baseline: false,
		acceptDrift: false,
		...over
	});
}

/** Ids 1..n. */
function range(n: number, from = 1): number[] {
	return Array.from({ length: n }, (_, k) => from + k);
}

/**
 * A last week of 100 listings from one provider, all seen again this week, plus `extra` brand-new ones. The
 * 100 keep every drift and window check away from the edge unless a test moves it on purpose.
 */
function crowd(extra: CleanListing[] = [], over: Partial<Input> = {}): CheckOutput {
	const ids = range(100);
	return run({
		state: stateOf(ids.map((i) => record(i))),
		pull: pullOf([provider(PROVIDER, [...ids, ...extra.map((l) => l.i)])]),
		clean: cleaned([...ids.map((i) => cleanRow(i)), ...extra]),
		...over
	});
}

function flOf(out: CheckOutput, id: number): string | undefined {
	return out.published.find((l) => l.i === id)?.fl;
}

describe('daysBetween', () => {
	it('counts whole UTC days across a month end and a clock change, and is negative backwards', () => {
		expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
		// The US clocks change on this date; local-time parsing would give a fraction of a day.
		expect(daysBetween('2026-03-08', '2026-03-09')).toBe(1);
		expect(daysBetween('2026-10-21', '2026-10-11')).toBe(-10);
	});
});

describe('runCheck: the contract check', () => {
	it('lets a clean week through with no blockers', () => {
		const out = crowd();
		expect(out.blockers).toEqual([]);
		expect(out.driftAbort).toBe(false);
	});

	it('holds the publish back once when published listings break the contract, but still returns them', () => {
		const ids = range(10);
		const out = run({
			state: stateOf(ids.map((i) => record(i))),
			pull: pullOf([provider(PROVIDER, ids)]),
			clean: cleaned(
				ids.map((i) => (i <= 2 ? cleanRow(i, { n: 'Example <b>Markup</b>' }) : cleanRow(i)))
			)
		});
		expect(out.blockers).toEqual(['E_INVALID_LISTING']);
		expect(out.published.map((l) => l.i)).toEqual(ids);
	});
});

describe('runCheck: blockers', () => {
	it.each([
		['a pull date that is not a date', { pullDate: 'not-a-date' }, 'E_BAD_PULL_DATE'],
		['a pull date equal to the last one', { pullDate: LAST_PULL }, 'E_PULL_DATE_ORDER'],
		['a pull date before the last one', { pullDate: '2026-10-07' }, 'E_PULL_DATE_ORDER'],
		[
			'a normal run with no baseline yet',
			{ state: stateOf([], { baselineDate: null }) },
			'E_NO_BASELINE'
		]
	] satisfies [string, Partial<Input>, string][])('stops on %s', (_name, over, code) => {
		expect(run(over).blockers).toContain(code);
	});

	it('lets the very first baseline run with no baseline date in the state', () => {
		const out = run({
			state: emptyState(),
			baseline: true,
			pull: pullOf([provider(PROVIDER, [1])]),
			clean: cleaned([cleanRow(1)])
		});
		expect(out.blockers).toEqual([]);
	});
});

describe('runCheck: the baseline', () => {
	it('marks nothing New, even a listing created yesterday, and sets the baseline date', () => {
		const out = run({
			state: emptyState(),
			baseline: true,
			pull: pullOf([provider(PROVIDER, [1, 2])]),
			clean: cleaned([cleanRow(1, { dc: '2026-10-20' }), cleanRow(2, { dc: '2025-03-01' })])
		});
		expect(out.week.added).toEqual([]);
		expect(out.published.map((l) => l.fl)).toEqual([PULL_DATE, PULL_DATE]);
		expect(out.nextState.baselineDate).toBe(PULL_DATE);
	});

	it('replaces an earlier baseline: no removals, no new orgs, no drift check, old records dropped', () => {
		const old = range(10);
		const fresh = range(50, 100);
		const out = run({
			state: stateOf(old.map((i) => record(i))),
			baseline: true,
			pull: pullOf([provider(PROVIDER, fresh)]),
			clean: cleaned(fresh.map((i) => cleanRow(i, { o: 999 })))
		});
		expect(out.removed).toEqual([]);
		expect(out.notSeen).toEqual([]);
		expect(out.week).toEqual({ pullDate: PULL_DATE, added: [], removed: [], newOrgs: [] });
		expect(out.driftAbort).toBe(false);
		expect(out.blockers).toEqual([]);
		expect(Object.keys(out.nextState.records)).toHaveLength(50);
		expect(out.nextState.records['1']).toBeUndefined();
	});
});

describe('runCheck: removal is proven, never guessed', () => {
	const ids = range(10);
	const seen = ids.slice(1);
	const recorded = stateOf(
		ids.map((i) => record(i, PROVIDER, 0, published(i, { fl: '2026-03-02' })))
	);
	const base = { state: recorded, clean: cleaned(seen.map((i) => cleanRow(i))) };

	it('removes an id its complete provider no longer returns, when the sum gate passed', () => {
		const out = run({ ...base, pull: pullOf([provider(PROVIDER, seen, true)]) });
		expect(out.removed).toEqual([1]);
		expect(out.notSeen).toEqual([]);
		expect(out.published.map((l) => l.i)).toEqual(seen);
		expect(out.nextState.records['1']).toBeUndefined();
		expect(out.week.removed).toEqual([1]);
	});

	it('keeps it as not seen, unchanged, when its provider is not proven complete', () => {
		const out = run({ ...base, pull: pullOf([provider(PROVIDER, seen, false)]) });
		expect(out.removed).toEqual([]);
		expect(out.notSeen).toEqual([1]);
		expect(out.published.find((l) => l.i === 1)).toEqual(published(1, { fl: '2026-03-02' }));
		expect(out.nextState.records['1']?.misses).toBe(1);
		expect(out.nextState.records['1']?.provider).toBe(PROVIDER);
	});

	it('counts the misses up on a second run in a row', () => {
		const first = run({ ...base, pull: pullOf([provider(PROVIDER, seen, false)]) });
		const second = run({
			...base,
			state: first.nextState,
			pullDate: '2026-10-28',
			pull: pullOf([provider(PROVIDER, seen, false)], { pullDate: '2026-10-28' })
		});
		expect(second.notSeen).toEqual([1]);
		expect(second.nextState.records['1']?.misses).toBe(2);
	});

	it('keeps it as not seen when the sum gate failed, even if its provider says complete', () => {
		const out = run({
			...base,
			pull: pullOf([provider(PROVIDER, seen, true)], { sumGate: false })
		});
		expect(out.removed).toEqual([]);
		expect(out.notSeen).toEqual([1]);
	});

	it('keeps it as not seen when its provider was not queried at all', () => {
		const out = run({ ...base, pull: pullOf([provider(OTHER_PROVIDER, [500], true)]) });
		expect(out.removed).toEqual([]);
		expect(out.notSeen).toEqual([1]);
	});

	it('never removes a listing of a renamed provider, and records the new name', () => {
		const renamed = run({
			state: stateOf([record(1, 'Example Old Name')]),
			pull: pullOf([
				provider('Example Old Name', [], true),
				provider('Example New Name', [1], true)
			]),
			clean: cleaned([cleanRow(1)])
		});
		expect(renamed.removed).toEqual([]);
		expect(renamed.notSeen).toEqual([]);
		expect(renamed.nextState.records['1']?.provider).toBe('Example New Name');
	});

	it('neither removes nor keeps an id that was merged into another', () => {
		const out = run({
			state: stateOf(ids.map((i) => record(i))),
			pull: pullOf([
				provider(
					PROVIDER,
					ids.filter((i) => i !== 2),
					true
				)
			]),
			clean: cleaned(
				ids.filter((i) => i !== 2).map((i) => cleanRow(i)),
				[[2, 1]]
			)
		});
		expect(out.removed).toEqual([]);
		expect(out.notSeen).toEqual([]);
		expect(out.published.some((l) => l.i === 2)).toBe(false);
		expect(out.nextState.records['2']).toBeUndefined();
	});

	// A provider renamed on the server shows up as an old name that is "complete" with nothing, beside a new
	// name that is still being read: its listings are not gone, they are not yet counted.
	it('keeps listings of a vanished provider name while the name they moved to is incomplete', () => {
		const all = range(20);
		const out = run({
			state: stateOf(all.map((i) => record(i, 'Example Old Name'))),
			pull: pullOf(
				[
					provider('Example Old Name', [], true),
					{ ...provider('Example New Name', range(14), false), total: 20 }
				],
				{ filtersProviders: ['Example New Name'] }
			),
			clean: cleaned(range(14).map((i) => cleanRow(i)))
		});
		expect(out.removed).toEqual([]);
		expect(out.notSeen).toEqual(range(6, 15));
	});

	it('removes it when its provider is still in Filters, though another provider is incomplete', () => {
		const out = run({
			...base,
			pull: pullOf([provider(PROVIDER, seen, true), provider(OTHER_PROVIDER, [], false)])
		});
		expect(out.removed).toEqual([1]);
	});

	it('removes it when its provider left Filters and every queried provider is complete', () => {
		const out = run({
			state: stateOf(ids.map((i) => record(i, i === 1 ? 'Example Gone Co' : PROVIDER))),
			pull: pullOf([provider('Example Gone Co', [], true), provider(PROVIDER, seen, true)], {
				filtersProviders: [PROVIDER]
			}),
			clean: cleaned(seen.map((i) => cleanRow(i)))
		});
		expect(out.removed).toEqual([1]);
	});

	it('keeps a listing its complete provider returned but the clean step set aside', () => {
		const out = run({
			...base,
			pull: pullOf([provider(PROVIDER, ids, true)])
		});
		expect(out.removed).toEqual([]);
		expect(out.week.removed).toEqual([]);
		expect(out.notSeen).toEqual([1]);
		expect(out.published.map((l) => l.i)).toContain(1);
		expect(out.nextState.records['1']?.misses).toBe(1);
	});

	it('credits an id to the first provider in order that returned it', () => {
		const out = run({
			state: stateOf([]),
			pull: pullOf([provider('Example First', [1]), provider('Example Second', [1])]),
			clean: cleaned([cleanRow(1)])
		});
		expect(out.nextState.records['1']?.provider).toBe('Example First');
	});
});

describe('runCheck: a kept listing still honours the suppression list', () => {
	it('publishes a not-seen listing without a suppressed contact, and stores it stripped', () => {
		const out = run({
			state: stateOf(
				[
					record(1, PROVIDER, 0, published(1, { e: 'Gone@Example.com' })),
					record(2, PROVIDER, 0, published(2, { e: 'keep@example.com' }))
				],
				{ suppression: ['gone@example.com'] }
			),
			pull: pullOf([provider(PROVIDER, [], false)]),
			clean: cleaned([])
		});
		const byId = (i: number) => out.published.find((l) => l.i === i);
		expect(out.notSeen).toEqual([1, 2]);
		expect('e' in (byId(1) ?? {})).toBe(false);
		expect(byId(2)?.e).toBe('keep@example.com');
		expect('e' in (out.nextState.records['1']?.listing ?? {})).toBe(false);
	});
});

describe('runCheck: a baseline that would drop earlier listings must be proven', () => {
	const earlier = stateOf(range(10).map((i) => record(i)));
	const baselineRun = (pull: PullRun, over: Partial<Input> = {}) =>
		run({
			state: earlier,
			baseline: true,
			pull,
			clean: cleaned(range(10).map((i) => cleanRow(i))),
			...over
		});

	it.each([
		['the sum gate failed', pullOf([provider(PROVIDER, range(10))], { sumGate: false })],
		['a queried provider is incomplete', pullOf([provider(PROVIDER, range(10), false)])]
	])('is held when %s', (_name, pull) => {
		expect(baselineRun(pull).blockers).toEqual(['E_BASELINE_UNPROVEN']);
	});

	it('goes ahead when Max accepts it', () => {
		const pull = pullOf([provider(PROVIDER, range(10))], { sumGate: false });
		expect(baselineRun(pull, { acceptDrift: true }).blockers).toEqual([]);
	});

	it('goes ahead when every provider is complete and the sum gate passed', () => {
		expect(baselineRun(pullOf([provider(PROVIDER, range(10))])).blockers).toEqual([]);
	});

	it('is not held for the very first baseline, which has nothing to drop', () => {
		const out = run({
			state: emptyState(),
			baseline: true,
			pull: pullOf([provider(PROVIDER, range(10), false)], { sumGate: false }),
			clean: cleaned(range(10).map((i) => cleanRow(i)))
		});
		expect(out.blockers).toEqual([]);
	});
});

describe('runCheck: overseas listings', () => {
	it('remembers the flag on seen and on kept records, and adds no key otherwise', () => {
		const ids = range(10);
		const seen = range(8, 3);
		const out = run({
			state: stateOf([...ids.map((i) => (i === 1 ? { ...record(i), overseas: true } : record(i)))]),
			pull: pullOf([provider(PROVIDER, seen, false)]),
			clean: { ...cleaned(seen.map((i) => cleanRow(i))), overseas: [4] }
		});
		const records = out.nextState.records;
		expect(out.notSeen).toEqual([1, 2]);
		expect(records['1']?.overseas).toBe(true);
		expect('overseas' in (records['2'] ?? {})).toBe(false);
		expect(records['4']?.overseas).toBe(true);
		expect('overseas' in (records['3'] ?? {})).toBe(false);
	});
});

describe('runCheck: what counts as New', () => {
	it('is New when created within 30 days of the pull (inclusive) or dated after it, else carries the baseline date', () => {
		const out = crowd([
			cleanRow(201, { dc: '2026-10-11' }),
			cleanRow(202, { dc: '2026-09-20' }),
			cleanRow(203, { dc: '2026-09-21' }),
			cleanRow(204, { dc: '2026-10-25' })
		]);
		expect(flOf(out, 201)).toBe(PULL_DATE);
		expect(flOf(out, 202)).toBe(BASELINE);
		expect(flOf(out, 203)).toBe(PULL_DATE);
		expect(flOf(out, 204)).toBe(PULL_DATE);
		expect(out.week.added).toEqual([201, 203, 204]);
	});

	it('keeps the first-listed date of a listing already recorded, however recent its creation date', () => {
		const ids = range(100);
		const out = run({
			state: stateOf(ids.map((i) => record(i, PROVIDER, 0, published(i, { fl: '2026-03-02' })))),
			pull: pullOf([provider(PROVIDER, ids)]),
			clean: cleaned(ids.map((i) => cleanRow(i, { dc: '2026-10-20' })))
		});
		expect(flOf(out, 5)).toBe('2026-03-02');
		expect(out.week.added).toEqual([]);
	});
});

describe('runCheck: drift', () => {
	/** 21 first sightings with old creation dates: none is New, yet all count as additions. */
	const surge = (n: number) => range(n, 300).map((i) => cleanRow(i, { dc: '2026-01-02' }));

	it('holds the publish when additions pass 20% of last week, whatever their first-listed date', () => {
		const out = crowd(surge(21));
		expect(out.driftAbort).toBe(true);
		expect(out.blockers).toContain('E_DRIFT');
	});

	it('lets it through when Max accepts the drift', () => {
		const out = crowd(surge(21), { acceptDrift: true });
		expect(out.driftAbort).toBe(false);
		expect(out.blockers).not.toContain('E_DRIFT');
	});

	it('lets exactly 20% through', () => {
		const out = crowd(surge(20));
		expect(out.driftAbort).toBe(false);
		expect(out.blockers).toEqual([]);
	});

	it('holds the publish when removals pass 20% of last week', () => {
		const ids = range(100);
		const seen = range(79, 22);
		const out = run({
			state: stateOf(ids.map((i) => record(i))),
			pull: pullOf([provider(PROVIDER, seen, true)]),
			clean: cleaned(seen.map((i) => cleanRow(i)))
		});
		expect(out.removed).toHaveLength(21);
		expect(out.driftAbort).toBe(true);
		expect(out.blockers).toContain('E_DRIFT');
	});

	// A baseline that published nothing must not leave every later week blocked by a comparison against zero.
	it('has nothing to compare against when last week published no listings', () => {
		const out = run({
			state: stateOf([]),
			pull: pullOf([provider(PROVIDER, [1, 2, 3])]),
			clean: cleaned([cleanRow(1), cleanRow(2), cleanRow(3)])
		});
		expect(out.driftAbort).toBe(false);
	});
});

describe('runCheck: the per-provider floor', () => {
	it('names a provider that fell below half of last week, only from 4 listings up, and never blocks', () => {
		const out = run({
			state: stateOf([], {
				providerCounts: [
					['Falls To Four', 10],
					['Falls To Five', 10],
					['Tiny', 3],
					['Not Queried', 10]
				]
			}),
			pull: pullOf([
				provider('Falls To Four', range(4)),
				provider('Falls To Five', range(5, 10)),
				provider('Tiny', [])
			])
		});
		expect(out.floorWarnings).toEqual([{ provider: 'Falls To Four', last: 10, now: 4 }]);
		expect(out.blockers).toEqual([]);
	});
});

describe('runCheck: new organizations', () => {
	it('lists organizations never published before, once each and sorted, not known ones', () => {
		const out = crowd([
			cleanRow(201, { o: 777, dc: '2026-01-02' }),
			cleanRow(202, { o: 555, dc: '2026-01-02' }),
			cleanRow(203, { o: 777, dc: '2026-01-02' }),
			cleanRow(204, { o: 301, dc: '2026-01-02' })
		]);
		expect(out.week.newOrgs).toEqual([555, 777]);
	});
});

describe('runCheck: company links', () => {
	it('puts an organization links on every listing of it, and adds no key where there are none', () => {
		const ids = range(4);
		const out = run({
			state: stateOf(ids.map((i) => record(i))),
			pull: pullOf([provider(PROVIDER, ids)]),
			clean: cleaned([
				cleanRow(1, { o: 301 }),
				cleanRow(2, { o: 301 }),
				cleanRow(3, { o: 302 }),
				cleanRow(4, { o: 303 })
			]),
			links: {
				byOrg: [
					[301, { w: 'https://example.com/', li: 'https://www.linkedin.com/company/example-wind' }],
					[302, { w: 'https://example.org/' }]
				],
				pinned: [],
				requests: 0
			}
		});
		const byId = (i: number) => out.published.find((l) => l.i === i);
		for (const i of [1, 2]) {
			expect(byId(i)?.w).toBe('https://example.com/');
			expect(byId(i)?.li).toBe('https://www.linkedin.com/company/example-wind');
		}
		expect(byId(3)?.w).toBe('https://example.org/');
		expect('li' in (byId(3) ?? {})).toBe(false);
		expect('w' in (byId(4) ?? {})).toBe(false);
		expect('li' in (byId(4) ?? {})).toBe(false);
		expect(out.blockers).toEqual([]);
	});
});

describe('runCheck: the state kept for next week', () => {
	const ids = range(10);
	const state = stateOf(
		ids.map((i) =>
			record(
				i,
				i === 2 ? OTHER_PROVIDER : PROVIDER,
				i === 3 ? 2 : 0,
				published(i, { fl: '2026-03-02' })
			)
		),
		{
			knownOrgs: [301, 100],
			suppression: ['removed@example.com'],
			providerCounts: [[PROVIDER, 10]]
		}
	);
	const before = structuredClone(state);
	const out = run({
		state,
		// Listing 1 is gone (its provider is complete), 2 is not seen (its provider is not), 11 is new.
		pull: pullOf(
			[
				provider(PROVIDER, [11, 10, 9, 8, 7, 6, 5, 4, 3], true),
				provider(OTHER_PROVIDER, [], false)
			],
			{ nextMode: 'full', filtersProviders: ['Example Filter A', PROVIDER] }
		),
		clean: cleaned(
			[11, 10, 9, 8, 7, 6, 5, 4, 3].map((i) => cleanRow(i, i === 11 ? { o: 500 } : {}))
		),
		links: { byOrg: [], pinned: [[301, 'https://example.com/']], requests: 0 }
	});

	it('publishes sorted by id and reports sorted lists', () => {
		expect(out.published.map((l) => l.i)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		expect(out.removed).toEqual([1]);
		expect(out.notSeen).toEqual([2]);
		expect(out.week).toEqual({ pullDate: PULL_DATE, added: [], removed: [1], newOrgs: [500] });
	});

	it('records each published listing with its provider this week and its miss count', () => {
		const records = out.nextState.records;
		expect(Object.keys(records).sort((a, b) => Number(a) - Number(b))).toEqual(
			out.published.map((l) => String(l.i))
		);
		expect(records['2']?.misses).toBe(1);
		// Seen again after two misses: the count starts over.
		expect(records['3']?.misses).toBe(0);
		expect(records['11']?.provider).toBe(PROVIDER);
	});

	it('carries the providers, counts, pinned sites, orgs, week, dates and mode forward', () => {
		const next = out.nextState;
		expect(next.v).toBe(1);
		expect(next.knownProviders).toEqual(['Example Filter A', PROVIDER]);
		expect(next.providerCounts).toEqual([
			[PROVIDER, 9],
			[OTHER_PROVIDER, 0]
		]);
		expect(next.pinnedSites).toEqual([[301, 'https://example.com/']]);
		expect(next.knownOrgs).toEqual([100, 301, 500]);
		expect(next.suppression).toEqual(['removed@example.com']);
		expect(next.lastWeek).toEqual(out.week);
		expect(next.lastPullDate).toBe(PULL_DATE);
		expect(next.baselineDate).toBe(BASELINE);
		expect(next.nextMode).toBe('full');
	});

	it('never changes the state it was given', () => {
		expect(state).toEqual(before);
	});
});
