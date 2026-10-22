import { describe, expect, test } from 'vitest';
import { cleanListing } from '../../src/lib/skillbridge-finder/fixtures/clean.ts';
import { validateListing } from '../../src/lib/skillbridge-finder/contract/validate.ts';
import type { CleanListing } from './types.ts';
import {
	acronym,
	domainLabel,
	emailDomain,
	isBlockedMailDomain,
	nameMatches,
	runLinks,
	squashName,
	type LinkDeps,
	type WikidataFacts
} from './links-core.ts';

const SITE = 'https://examplewindservices.test/';

function listing(i: number, o: number, n: string, e?: string): CleanListing {
	return {
		i,
		o,
		n,
		p: 'Field Technician Internship',
		m: 1,
		b: [],
		ind: [],
		dib: false,
		dc: '2026-07-24',
		...(e === undefined ? {} : { e })
	};
}

/** Deps that record everything they are asked; `live` lists the home pages the site check passes. */
function makeDeps(facts: Record<string, WikidataFacts> = {}, live: string[] = []) {
	const wikidataCalls: string[][] = [];
	const siteCalls: string[] = [];
	const deps: LinkDeps = {
		wikidata: async (names) => {
			wikidataCalls.push([...names]);
			return new Map(Object.entries(facts));
		},
		siteCheck: async (url) => {
			siteCalls.push(url);
			return live.includes(url);
		}
	};
	return { deps, wikidataCalls, siteCalls };
}

describe('emailDomain', () => {
	test('lowercases the domain and refuses what is not a plain address domain', () => {
		expect(emailDomain('Jobs@ExampleWindServices.test')).toBe('examplewindservices.test');
		for (const bad of [
			'no-at-sign',
			'jobs@',
			'jobs@localhost',
			'jobs@-bad.test',
			'jobs@exa_mple.test',
			'jobs@exa mple.test',
			'jobs@examplewindservices.test.'
		])
			expect(emailDomain(bad), bad).toBeNull();
	});
});

describe('isBlockedMailDomain', () => {
	test('blocks government, free mail and ISP mail (and their subdomains), and never fetches linkedin', () => {
		for (const blocked of [
			'army.mil',
			'example.gov',
			'gmail.com',
			'mail.comcast.net',
			'yahoo.com',
			'linkedin.com',
			'www.linkedin.com'
		])
			expect(isBlockedMailDomain(blocked), blocked).toBe(true);
	});

	test('lets a company domain through, including one that merely ends like a blocked name', () => {
		for (const ok of ['examplewindservices.test', 'notgmail.com', 'gmail.com.example.test'])
			expect(isBlockedMailDomain(ok), ok).toBe(false);
	});
});

describe('name matching', () => {
	test('squashName drops trailing legal words and keeps only letters and digits', () => {
		const fullwidthE = String.fromCharCode(0xff25);
		const table: [string, string][] = [
			['Example Wind Services, Inc.', 'examplewindservices'],
			['Acme L.L.C.', 'acme'],
			['Foo Co., Ltd.', 'foo'],
			['Wind Corporation', 'wind'],
			[fullwidthE + 'xample Wind', 'examplewind'],
			// A name that is only a legal word keeps it: stripping it would leave nothing to match.
			['Company', 'company']
		];
		for (const [name, squashed] of table) expect(squashName(name), name).toBe(squashed);
	});

	test('acronym takes the first letters, skips of/and/the/&, and needs two letters', () => {
		expect(acronym('Example Wind Services')).toBe('ews');
		expect(acronym('Bureau of Wind & Sun and the Sea, Inc.')).toBe('bwss');
		expect(acronym('Acme')).toBe('');
	});

	test('domainLabel is the label left of the last dot', () => {
		expect(domainLabel('mail.example.com')).toBe('example');
		expect(domainLabel('examplewindservices.test')).toBe('examplewindservices');
	});

	test('a Wikidata site host matches the domain, ignoring a leading www', () => {
		expect(nameMatches('Totally Different', 'windco.test', 'https://www.windco.test/about')).toBe(
			true
		);
		expect(nameMatches('Totally Different', 'windco.test', 'https://other.test/')).toBe(false);
		expect(nameMatches('Totally Different', 'windco.test', 'not a url')).toBe(false);
		expect(nameMatches('Totally Different', 'windco.test')).toBe(false);
	});
});

describe('runLinks website', () => {
	test('a squashed-name match is checked once, shown, and pinned', async () => {
		const { deps, siteCalls } = makeDeps({}, [SITE]);
		const out = await runLinks(
			[listing(10, 301, 'Example Wind Services, Inc.', 'jobs@examplewindservices.test')],
			[],
			deps
		);
		expect(siteCalls).toEqual([SITE]);
		expect(out).toEqual({ byOrg: [[301, { w: SITE }]], pinned: [[301, SITE]], requests: 1 });
	});

	test('an acronym match is checked', async () => {
		const { deps, siteCalls } = makeDeps({}, ['https://ews.test/']);
		const out = await runLinks(
			[listing(10, 301, 'Example Wind Services', 'jobs@ews.test')],
			[],
			deps
		);
		expect(siteCalls).toEqual(['https://ews.test/']);
		expect(out.byOrg).toEqual([[301, { w: 'https://ews.test/' }]]);
	});

	test("Wikidata's official website host makes a differently named domain a candidate", async () => {
		const { deps, siteCalls } = makeDeps(
			{ 'Totally Different Name': { site: 'https://www.windco.test/' } },
			['https://windco.test/']
		);
		const out = await runLinks(
			[listing(10, 301, 'Totally Different Name', 'jobs@windco.test')],
			[],
			deps
		);
		expect(siteCalls).toEqual(['https://windco.test/']);
		expect(out.byOrg).toEqual([[301, { w: 'https://windco.test/' }]]);
	});

	test('a failed check shows nothing and pins nothing', async () => {
		const { deps, siteCalls } = makeDeps();
		const out = await runLinks(
			[listing(10, 301, 'Example Wind Services', 'jobs@examplewindservices.test')],
			[],
			deps
		);
		expect(siteCalls).toEqual([SITE]);
		expect(out).toEqual({ byOrg: [], pinned: [], requests: 1 });
	});

	test('a name that does not match the domain makes no request', async () => {
		const { deps, siteCalls } = makeDeps({}, ['https://unrelated.test/']);
		const out = await runLinks(
			[listing(10, 301, 'Example Wind Services', 'jobs@unrelated.test')],
			[],
			deps
		);
		expect(siteCalls).toEqual([]);
		expect(out).toEqual({ byOrg: [], pinned: [], requests: 0 });
	});

	test('a domain shared with another organization is never shown, even when both names match', async () => {
		const { deps, siteCalls } = makeDeps({}, [SITE]);
		const out = await runLinks(
			[
				listing(10, 301, 'Example Wind Services Inc', 'jobs@examplewindservices.test'),
				listing(20, 302, 'Example Wind Services LLC', 'hr@other302.test'),
				// Organization 302 uses the domain on a later listing, not its first.
				listing(21, 302, 'Example Wind Services LLC', 'jobs@examplewindservices.test')
			],
			[],
			deps
		);
		expect(siteCalls).toEqual([]);
		expect(out.byOrg).toEqual([]);
	});

	test('the candidate comes from the lowest-id listing, however the list is ordered', async () => {
		const { deps, siteCalls } = makeDeps({}, [SITE]);
		const out = await runLinks(
			[
				listing(12, 301, 'Example Wind Services', 'jobs@unrelated.test'),
				listing(11, 301, 'Example Wind Services', 'jobs@examplewindservices.test')
			],
			[],
			deps
		);
		expect(siteCalls).toEqual([SITE]);
		expect(out.byOrg).toEqual([[301, { w: SITE }]]);
	});

	test('a pinned organization gets its pinned site with no request, whatever its name', async () => {
		const { deps, siteCalls } = makeDeps();
		const out = await runLinks(
			[listing(10, 301, 'Zzz Holdings', 'jobs@examplewindservices.test')],
			[[301, SITE]],
			deps
		);
		expect(siteCalls).toEqual([]);
		expect(out).toEqual({ byOrg: [[301, { w: SITE }]], pinned: [[301, SITE]], requests: 0 });
	});

	test('a pinned site that breaks the published rule is neither shown nor kept', async () => {
		const { deps } = makeDeps();
		const out = await runLinks(
			[
				listing(10, 301, 'Zzz Holdings', 'jobs@examplewindservices.test'),
				listing(20, 302, 'Yyy Holdings', 'jobs@yyy.test')
			],
			[
				[301, 'http://examplewindservices.test/'],
				[302, 'https://yyy.test/path']
			],
			deps
		);
		expect(out).toEqual({ byOrg: [], pinned: [], requests: 0 });
	});

	test('results are sorted by organization id', async () => {
		const { deps } = makeDeps({}, ['https://ews.test/', SITE]);
		const out = await runLinks(
			[
				listing(30, 305, 'Example Wind Services', 'jobs@ews.test'),
				listing(10, 301, 'Example Wind Services Inc', 'jobs@examplewindservices.test')
			],
			[],
			deps
		);
		expect(out.byOrg.map(([org]) => org)).toEqual([301, 305]);
		expect(out.pinned.map(([org]) => org)).toEqual([301, 305]);
	});
});

describe('runLinks LinkedIn', () => {
	test('a Wikidata id builds the company page, which the contract accepts, and is never requested', async () => {
		const { deps, siteCalls, wikidataCalls } = makeDeps(
			{ 'Example Wind Services': { linkedinId: 'example-wind-services' } },
			[SITE]
		);
		const out = await runLinks(
			[listing(10, 301, 'Example Wind Services', 'jobs@examplewindservices.test')],
			[],
			deps
		);
		const li = 'https://www.linkedin.com/company/example-wind-services';
		expect(out.byOrg).toEqual([[301, { w: SITE, li }]]);
		expect(validateListing(cleanListing({ li }))).toEqual([]);
		for (const seen of [...siteCalls, ...wikidataCalls.flat()])
			expect(seen).not.toContain('linkedin');
	});

	test('LinkedIn does not need a website or an email', async () => {
		const { deps, siteCalls } = makeDeps({ 'Example Wind Services': { linkedinId: 'ews' } });
		const out = await runLinks([listing(10, 301, 'Example Wind Services')], [], deps);
		expect(siteCalls).toEqual([]);
		expect(out.byOrg).toEqual([[301, { li: 'https://www.linkedin.com/company/ews' }]]);
	});

	test('an id that could change the path or add a query builds nothing', async () => {
		for (const linkedinId of ['a/b', 'a?x=1', '../x', 'a#b', '']) {
			const { deps } = makeDeps({ 'Example Wind Services': { linkedinId } });
			const out = await runLinks([listing(10, 301, 'Example Wind Services')], [], deps);
			expect(out.byOrg, linkedinId).toEqual([]);
		}
	});
});

describe('runLinks Wikidata', () => {
	test('is asked once, for every organization name, deduplicated', async () => {
		const { deps, wikidataCalls } = makeDeps();
		await runLinks(
			[
				listing(10, 301, 'Example Wind Services', 'jobs@examplewindservices.test'),
				listing(11, 301, 'Example Wind Services', 'jobs@examplewindservices.test'),
				listing(20, 302, 'Example Wind Services'),
				listing(30, 303, 'Other Name Entirely')
			],
			[],
			deps
		);
		expect(wikidataCalls).toHaveLength(1);
		expect([...(wikidataCalls[0] ?? [])].sort()).toEqual([
			'Example Wind Services',
			'Other Name Entirely'
		]);
	});
});
