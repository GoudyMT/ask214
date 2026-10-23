import { describe, it, expect } from 'vitest';
import { branchesLine, jobCodesLine, lengthLine, mailtoHref, placeLine, safeHttps } from './format';
import { CLEAN_CASES, cleanListing } from '../fixtures/clean';
import { BRANCHES, type Listing } from '../contract/listing';

/** The listing without one of its optional facts; an unset fact is absent, not undefined. */
function omit(listing: Listing, key: 'c' | 'd' | 'oc'): Listing {
	const copy = { ...listing };
	delete copy[key];
	return copy;
}

describe('placeLine', () => {
	it('gives the city and state with the distance when there is one', () => {
		expect(placeLine(cleanListing({ ls: ['MD'] }), 12.4)).toBe('Columbia, MD - 12 mi');
	});

	it('gives the city and state alone without a distance', () => {
		expect(placeLine(cleanListing({ ls: ['MD'] }))).toBe('Columbia, MD');
	});

	it('counts the states of a many-state program, and says Online for an online one', () => {
		expect(placeLine(CLEAN_CASES.multiState)).toBe('Offered in 13 states');
		expect(placeLine(CLEAN_CASES.remote)).toBe('Online');
	});

	// An online listing may carry a state from an old row; its place is still "Online".
	it('says Online before it looks at any place the listing also names', () => {
		expect(placeLine(cleanListing({ m: 2, ls: ['MD'] }), 4)).toBe('Online');
	});

	it('names the state when no city is listed, and says so when nothing is', () => {
		expect(placeLine(omit(cleanListing({ ls: ['MD'] }), 'c'))).toBe('Maryland, no city listed');
		expect(placeLine(CLEAN_CASES.locationUnknown)).toBe('Location not listed');
	});

	it('gives a hybrid program its place like an in-person one', () => {
		expect(placeLine(cleanListing({ m: 3, ls: ['MD'] }), 3)).toBe('Columbia, MD - 3 mi');
	});
});

describe('lengthLine', () => {
	it.each([
		['91-120', '91-120 days'],
		['180+', '180+ days'],
		[undefined, 'Length not listed']
	] as const)('words %s as %s', (d, words) => {
		expect(lengthLine(d === undefined ? omit(cleanListing(), 'd') : cleanListing({ d }))).toBe(
			words
		);
	});
});

describe('branchesLine', () => {
	it('lists the branches named, says All branches for all six and Any branch for none', () => {
		expect(branchesLine(cleanListing({ b: ['Navy', 'Coast Guard'] }))).toBe('Navy, Coast Guard');
		expect(branchesLine(cleanListing({ b: [...BRANCHES] }))).toBe('All branches');
		expect(branchesLine(cleanListing({ b: [] }))).toBe('Any branch');
	});
});

describe('jobCodesLine', () => {
	it('joins the codes, or says open to all, or says none are listed', () => {
		expect(jobCodesLine(cleanListing({ oc: ['91B', 'EM'] }))).toBe('91B, EM');
		expect(jobCodesLine(CLEAN_CASES.multiState)).toBe('Open to all occupations');
		expect(jobCodesLine(omit(cleanListing(), 'oc'))).toBe('No codes listed');
	});
});

describe('safeHttps', () => {
	it('keeps an https address', () => {
		expect(safeHttps('https://example.com/a?b=1')?.href).toBe('https://example.com/a?b=1');
	});

	// A link from the record is the one place a program's own text becomes something a tap can run.
	it.each([
		['a script address', 'javascript:alert(1)'],
		['a data address', 'data:text/html,<b>x</b>'],
		['plain http', 'http://example.com/'],
		['an address with a login', 'https://user:pass@example.com/'],
		['not an address', 'example.com'],
		['nothing', undefined]
	])('refuses %s', (_name, raw) => {
		expect(safeHttps(raw)).toBeNull();
	});
});

describe('mailtoHref', () => {
	it('encodes the whole address, so extra headers cannot ride along', () => {
		expect(mailtoHref('careers@example.org')).toBe('mailto:careers%40example.org');
		expect(mailtoHref('a@example.org?bcc=x@example.org&body=hi')).toBe(
			'mailto:a%40example.org%3Fbcc%3Dx%40example.org%26body%3Dhi'
		);
	});
});
