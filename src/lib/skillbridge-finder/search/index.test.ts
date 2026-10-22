import { describe, it, expect } from 'vitest';
import type { Industry, Listing } from '../contract/listing';
import type { StateCode } from '../contract/places';
import type { CrosswalkTable } from '../contract/tables';
import { cleanListing } from '../fixtures/clean';
import { buildSearchIndex, search } from './index';

type Fields = {
	n: string;
	p: string;
	c: string;
	s: StateCode;
	ls?: StateCode[];
	r: string[];
	ind: Industry[];
	oc: string[] | 'all';
};

/** A listing whose every searchable field is stated, so no default from the fixture leaks a word into it. */
const listing = (i: number, f: Fields): Listing =>
	cleanListing({
		i,
		n: f.n,
		p: f.p,
		c: f.c,
		s: f.s,
		ls: f.ls ?? [f.s],
		r: f.r,
		ind: f.ind,
		oc: f.oc
	});

const WELDER = listing(1, {
	n: 'Acme Robotics',
	p: 'Welding Apprenticeship',
	c: 'Tulsa',
	s: 'OK',
	r: ['Welder'],
	ind: ['Production'],
	oc: ['11B']
});
const CHEF = listing(2, {
	n: 'Borealis Foods',
	p: 'Cooking Program',
	c: 'Anchorage',
	s: 'AK',
	r: ['Chef'],
	ind: ['Food Preparation and Serving Related'],
	oc: ['92G']
});
const ALL_CODES = listing(3, {
	n: 'Cobalt Logistics',
	p: 'Supply Fellowship',
	c: 'Norfolk',
	s: 'VA',
	ls: ['VA', 'NC'],
	r: ['Dispatcher'],
	ind: ['Transportation and Material Moving'],
	oc: 'all'
});
const NAVY_CHEF = listing(4, {
	n: 'Delta Air Services',
	p: 'Hangar Internship',
	c: 'Pensacola',
	s: 'FL',
	r: ['Airframe Mechanic'],
	ind: ['Installation, Maintenance, and Repair'],
	oc: ['MS', '88N']
});
const AIR_FORCE_CHEF = listing(5, {
	n: 'Ember Labs',
	p: 'Data Fellowship',
	c: 'Austin',
	s: 'TX',
	r: ['Analyst'],
	ind: ['Computer and Mathematical'],
	oc: ['3M0X1']
});
const ALL = [WELDER, CHEF, ALL_CODES, NAVY_CHEF, AIR_FORCE_CHEF];

// The same civilian job under three branches' codes, and one code whose title adds a word nothing else has.
const CROSSWALK: CrosswalkTable = {
	v: 1,
	rows: [
		['92G', 'Army', '35-1011.00', 'Chefs and Head Cooks'],
		['MS', 'Navy', '35-1011.00', 'Chefs and Head Cooks'],
		['3M0X1', 'Air Force', '35-1011.00', 'Chefs and Head Cooks'],
		['88N', 'Army', '13-1081.00', 'Logistics Planners']
	]
};

const find = (query: string, listings: readonly Listing[] = ALL, crosswalk?: CrosswalkTable) =>
	search(buildSearchIndex(listings, crosswalk), query);

describe('the fields a search reads', () => {
	it.each([
		['organization', 'robotics', [1]],
		['program', 'cooking', [2]],
		['a role', 'dispatcher', [3]],
		['a city', 'anchorage', [2]],
		['a state name', 'oklahoma', [1]],
		['a state code', 'ak', [2]],
		['a state the listing also names', 'carolina', [3]],
		['an industry', 'transportation', [3]],
		['a military job code, in any case', '11B', [1]]
	])('finds a listing by %s', (_field, query, ids) => {
		expect(find(query)).toEqual(ids);
	});

	// Words that are in the file only to be read by a person are never searched.
	it('does not read a listing field that is not searchable', () => {
		const withEmail = [
			cleanListing({ ...WELDER, e: 'zebraquartz@example.com', w: 'https://quartzco.example.com/' })
		];
		expect(find('zebraquartz', withEmail)).toEqual([]);
		expect(find('quartzco', withEmail)).toEqual([]);
	});
});

describe('the words of a query', () => {
	it('finds only listings that match every word', () => {
		expect(find('welding tulsa')).toEqual([1]);
		expect(find('welding anchorage')).toEqual([]);
	});

	it('returns everything, in the order given, for an empty or separator-only query', () => {
		const shuffled = [ALL_CODES, WELDER, CHEF];
		expect(find('', shuffled)).toEqual([3, 1, 2]);
		expect(find(' - , ', shuffled)).toEqual([3, 1, 2]);
	});

	it('returns matches in the order the listings were given', () => {
		expect(find('fellowship', [AIR_FORCE_CHEF, ALL_CODES])).toEqual([5, 3]);
	});

	// "Field-Technician" is one field in the file and two words to the person typing it.
	it('splits on punctuation and case in both the listing and the query', () => {
		const hyphen = [
			listing(6, {
				n: 'Gamma',
				p: 'Field-Technician Internship',
				c: 'X',
				s: 'OK',
				r: ['A'],
				ind: ['Production'],
				oc: ['ZZ']
			})
		];
		expect(find('field technician', hyphen)).toEqual([6]);
		expect(find('FIELD-TECHNICIAN', hyphen)).toEqual([6]);
	});

	it('treats an accented letter as part of a word', () => {
		const n = String.fromCharCode(0xf1);
		const city = [
			listing(7, {
				n: 'Gamma',
				p: 'Intern',
				c: `Ca${n}on City`,
				s: 'CO',
				r: ['A'],
				ind: ['Production'],
				oc: ['ZZ']
			})
		];
		expect(find(`ca${n}on`, city)).toEqual([7]);
		// The accent does not cut the name in two, so its tail is not a word of its own.
		expect(find('on', city)).toEqual([]);
	});
});

describe('typing as you go and slips of the thumb', () => {
	it('matches the start of a word from 3 letters, not from 2', () => {
		expect(find('wel')).toEqual([1]);
		expect(find('we')).toEqual([]);
	});

	it.each([
		['a wrong letter', 'tulsq'],
		['an extra letter', 'tulsaa'],
		['a missing letter', 'robotcs']
	])('forgives one slip in a word of 5 or more letters: %s', (_slip, word) => {
		expect(find(word)).toHaveLength(1);
	});

	// Four-letter words are too short: one slip would turn "chef" into other real words.
	it('does not forgive a slip in a word of 4 letters', () => {
		expect(find('chef')).toEqual([2]);
		expect(find('chaf')).toEqual([]);
	});

	it('does not forgive two slips in a long word', () => {
		expect(find('rubutics')).toEqual([]);
	});
});

describe('military job codes through the crosswalk', () => {
	// The listing says "88N"; the person types the civilian word. The title comes from the O*NET crosswalk.
	it('finds a listing by a word in the civilian title of a code it names', () => {
		expect(find('planners', ALL, CROSSWALK)).toEqual([4]);
		expect(find('cooks', ALL, CROSSWALK)).toEqual([2, 4, 5]);
	});

	it("finds a listing that names another branch's code for the same civilian job", () => {
		expect(find('3m0x1', ALL, CROSSWALK)).toEqual([2, 4, 5]);
		expect(find('92G', ALL, CROSSWALK)).toEqual([2, 4, 5]);
		expect(find('3m0x1 anchorage', ALL, CROSSWALK)).toEqual([2]);
	});

	it('does not stretch a code the crosswalk does not know', () => {
		expect(find('11b', ALL, CROSSWALK)).toEqual([1]);
	});

	// "All occupations" says nothing about this person's job, so a code never finds it.
	it('does not match a listing open to all occupations by a code', () => {
		expect(find('92g', ALL, CROSSWALK)).not.toContain(3);
		expect(find('11b')).not.toContain(3);
	});

	it('without a crosswalk, searches the same but a code finds only listings naming it', () => {
		expect(find('robotics')).toEqual([1]);
		expect(find('3m0x1')).toEqual([5]);
		expect(find('planners')).toEqual([]);
		expect(find('cooks')).toEqual([]);
	});
});
