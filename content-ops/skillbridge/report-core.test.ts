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
			links: { website: 0, linkedin: 0, lastWebsite: 0, lastLinkedin: 0 },
			files: [
				{ name: 'south-atlantic', count: 2, bytes: 700 },
				{ name: 'remote', count: 1, bytes: 300 }
			]
		});
	});

	// A Wikidata outage leaves a week with no LinkedIn links and no error anywhere; the drop has to show here.
	it('shows how many listings carry a website and a LinkedIn link beside last week', () => {
		const lastOf = (i: number, over: Partial<Listing>) => ({
			listing: listing(i, over),
			provider: 'Example Provider One',
			misses: 0
		});
		const lastWeek = Object.fromEntries(
			[
				lastOf(1, { w: 'https://example.com/', li: 'https://www.linkedin.com/company/a' }),
				lastOf(2, { w: 'https://example.org/', li: 'https://www.linkedin.com/company/b' }),
				lastOf(3, { li: 'https://www.linkedin.com/company/c' }),
				lastOf(4, {})
			].map((r) => [String(r.listing.i), r])
		);
		const report = buildReport({
			pull: ok(runOf()),
			clean: CLEAN,
			check: checkOf({
				published: [
					listing(1, { w: 'https://example.com/' }),
					listing(2, { w: 'https://example.org/' }),
					listing(3),
					listing(4)
				]
			}),
			week: weekOf(),
			lastRecords: lastWeek,
			baseline: false,
			pullDate: PULL_DATE
		});
		expect(report.links).toEqual({ website: 2, linkedin: 0, lastWebsite: 2, lastLinkedin: 3 });
		expect(reportText(report)).toContain(
			'Company links: website 2 (last week 2), LinkedIn 0 (last week 3)'
		);
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

	// A stop is not a failed check: the runbook's "When the run stops" section is the one Max must read, and zeros
	// from a pull that never finished must not read as a sum gate that failed.
	it('words a stopped pull as stopped, not as a blocked week or a failed sum gate', () => {
		const text = reportText(
			buildReport({
				pull: { ok: false, stop: 'E_HTTP_429', requests: 2, elapsedMs: 3000 },
				baseline: false,
				pullDate: PULL_DATE
			})
		);
		expect(text).toContain(
			'Publish: STOPPED (E_HTTP_429). Do not deploy; see "When the run stops".'
		);
		expect(text).not.toContain('BLOCKED');
		expect(text).not.toContain('sum gate');
		expect(text).toContain('Pull: stopped after 2 requests, so there are no totals.');
	});

	it('names the request the server refused, so a rate limit can be told from a block', () => {
		const report = buildReport({
			pull: {
				ok: false,
				stop: 'E_HTTP_403',
				requests: 7,
				elapsedMs: 27000,
				stoppedAt: '/Location/LookupSkillbridge'
			},
			baseline: true,
			pullDate: PULL_DATE
		});
		expect(report.stoppedAt).toBe('/Location/LookupSkillbridge');
		expect(reportText(report)).toContain('Stopped at request 7: /Location/LookupSkillbridge');
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
