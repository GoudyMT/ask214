import { describe, expect, it } from 'vitest';
import { emptyState } from './check-core.ts';
import { buildReport, reportText } from './report-core.ts';
import type { RunReport } from './report-core.ts';
import type { BuiltWeek } from './layout-core.ts';
import type { CheckOutput, CleanOutput, PullOutcome, PullRun, ProviderResult } from './types.ts';
import type { Listing } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import { rawListing } from '../../src/lib/skillbridge-finder/fixtures/raw.ts';

const PULL_DATE = '2026-10-21';
const PLANTED_EMAIL = 'planted@example.com';
const PLANTED_NAME = 'Pat Planted';

function provider(name: string, over: Partial<ProviderResult> = {}): ProviderResult {
	return { name, total: 4, ids: [1, 2, 3, 4], complete: true, cappedQueries: 0, ...over };
}

function listing(i: number, over: Partial<Listing> = {}): Listing {
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
		fl: '2026-01-05',
		...over
	};
}

function runOf(over: Partial<PullRun> = {}): PullRun {
	return {
		mode: 'full',
		pullDate: PULL_DATE,
		totalN: 12,
		totalPositions: 13,
		filtersProviders: [],
		rows: Array.from({ length: 11 }, (_, k) =>
			rawListing({ id: 100 + k, employerPoc: PLANTED_NAME, employerPocEmail: PLANTED_EMAIL })
		),
		providers: [
			provider('Example Provider One'),
			provider('Example Provider Two', { complete: false, cappedQueries: 2 }),
			provider('Example Provider Three', { complete: false, cappedQueries: 2 })
		],
		sumOfTotals: 12,
		sumGate: true,
		dormantSwept: true,
		nextMode: 'weekly',
		requests: 321,
		elapsedMs: 456_000,
		...over
	};
}

const CLEAN: CleanOutput = {
	listings: [],
	aliases: [],
	quarantine: [
		{ id: 1, code: 'E_BAD_STATE' },
		{ id: 2, code: 'E_BAD_STATE' },
		{ id: 3, code: 'E_NO_ORG' }
	],
	dropped: { E_DROP_MARKUP: 4 },
	overseas: []
};

function checkOf(over: Partial<CheckOutput> = {}): CheckOutput {
	return {
		published: [listing(1, { e: PLANTED_EMAIL }), listing(2), listing(3), listing(4), listing(5)],
		week: { pullDate: PULL_DATE, added: [1, 2, 3], removed: [7, 8, 11, 12], newOrgs: [5] },
		notSeen: [9, 10],
		removed: [7, 8, 11, 12],
		floorWarnings: [{ provider: 'Example Provider Two', last: 10, now: 4 }],
		driftAbort: true,
		blockers: ['E_DRIFT'],
		nextState: emptyState(),
		...over
	};
}

function weekOf(over: Partial<BuiltWeek> = {}): BuiltWeek {
	return {
		files: [],
		index: {
			v: 1,
			pullDate: PULL_DATE,
			baseline: false,
			baselineDate: '2026-01-05',
			files: [
				{ name: 'south-atlantic', count: 2, bytes: 700 },
				{ name: 'remote', count: 1, bytes: 300 }
			]
		},
		errors: [],
		...over
	};
}

const ok = (run: PullRun): PullOutcome => ({ ok: true, run });

function fullReport(): RunReport {
	return buildReport({
		pull: ok(runOf()),
		clean: CLEAN,
		check: checkOf(),
		week: weekOf(),
		baseline: false,
		pullDate: PULL_DATE
	});
}

describe('buildReport', () => {
	it('counts everything Max reads before deploying', () => {
		expect(fullReport()).toEqual({
			pullDate: PULL_DATE,
			mode: 'full',
			baseline: false,
			requests: 321,
			elapsedMs: 456_000,
			totalN: 12,
			sumOfTotals: 12,
			sumGate: true,
			totalPositions: 13,
			uniqueIds: 11,
			providersQueried: 3,
			providersIncomplete: 2,
			cappedQueries: 4,
			dormantSwept: true,
			quarantine: { E_BAD_STATE: 2, E_NO_ORG: 1 },
			dropped: { E_DROP_MARKUP: 4 },
			published: 5,
			added: 3,
			removed: 4,
			notSeen: 2,
			newOrgs: 1,
			driftAbort: true,
			blockers: ['E_DRIFT'],
			floorWarnings: [{ provider: 'Example Provider Two', last: 10, now: 4 }],
			files: [
				{ name: 'south-atlantic', count: 2, bytes: 700 },
				{ name: 'remote', count: 1, bytes: 300 }
			]
		});
	});

	// The two totals differ only when some listing is unaccounted for: the case Max most needs to see.
	it('reports a failed sum gate with both totals, in the data and in the text', () => {
		const report = buildReport({
			pull: ok(runOf({ totalN: 12, sumOfTotals: 10, sumGate: false })),
			clean: CLEAN,
			check: checkOf(),
			week: weekOf(),
			baseline: false,
			pullDate: PULL_DATE
		});
		expect(report).toMatchObject({ totalN: 12, sumOfTotals: 10, sumGate: false });
		expect(reportText(report)).toContain('N 12; sum of provider totals 10 (sum gate FAILED)');
		expect(reportText(fullReport())).toContain('sum gate passed');
	});

	it('names the stop code of a stopped pull and reports nothing it never learned', () => {
		const report = buildReport({
			pull: { ok: false, stop: 'E_HTTP_429', requests: 5, elapsedMs: 9000 },
			baseline: false,
			pullDate: PULL_DATE
		});
		expect(report.stop).toBe('E_HTTP_429');
		expect(report).toMatchObject({
			requests: 5,
			elapsedMs: 9000,
			uniqueIds: 0,
			published: 0,
			providersQueried: 0,
			files: [],
			quarantine: {}
		});
		expect(reportText(report)).toContain('E_HTTP_429');
	});

	it('also holds the week when the files could not be built, so Max sees why', () => {
		const report = buildReport({
			pull: ok(runOf()),
			clean: CLEAN,
			check: checkOf({ blockers: ['E_INVALID_LISTING'] }),
			week: weekOf({ errors: ['E_INVALID_REGION', 'E_INVALID_LISTING'] }),
			baseline: false,
			pullDate: PULL_DATE
		});
		expect(report.blockers).toEqual(['E_INVALID_LISTING', 'E_INVALID_REGION']);
	});

	it('never carries a contact email or name from a listing or a raw row', () => {
		const report = fullReport();
		for (const text of [JSON.stringify(report), reportText(report)]) {
			expect(text).not.toContain(PLANTED_EMAIL);
			expect(text).not.toContain(PLANTED_NAME);
			expect(text).not.toContain('example.com');
		}
	});
});

describe('reportText', () => {
	it('shows the site total beside the unique ids, and says whether the week is held', () => {
		const text = reportText(fullReport());
		expect(text).toContain('site total 13');
		expect(text).toContain('unique ids 11');
		expect(text).toContain('BLOCKED');
		expect(text).toContain('E_DRIFT');
		expect(text).toContain('Example Provider Two');
		expect(text).toContain('south-atlantic');

		const clear = reportText(
			buildReport({
				pull: ok(runOf()),
				clean: CLEAN,
				check: checkOf({ blockers: [], driftAbort: false }),
				week: weekOf(),
				baseline: false,
				pullDate: PULL_DATE
			})
		);
		expect(clear).not.toContain('BLOCKED');
	});

	// Provider names come from a server we do not control and can hold any character, line breaks included.
	it('is plain ASCII, and a provider name cannot start a line of its own', () => {
		const odd = 'Caf' + String.fromCharCode(0xe9) + '\nPublish: clear';
		const report = buildReport({
			pull: ok(runOf()),
			clean: CLEAN,
			check: checkOf({
				blockers: [],
				driftAbort: false,
				floorWarnings: [{ provider: odd, last: 10, now: 1 }]
			}),
			week: weekOf(),
			baseline: false,
			pullDate: PULL_DATE
		});
		const text = reportText(report);
		expect(
			[...text].every((c) => c === '\n' || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127))
		).toBe(true);
		// Only the report's own verdict line says it: exactly one.
		expect(text.split('\n').filter((line) => line.startsWith('Publish:'))).toHaveLength(1);
	});
});
