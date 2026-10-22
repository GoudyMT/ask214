/**
 * The shape of one published SkillBridge listing and of the files that carry them - the contract between the
 * weekly pipeline that writes them and the app that reads them. Facts only: the provider's prose (summary, job
 * description, eligibility text) and contact names never appear, and the validator refuses any key not listed
 * here. Keys are short because every byte is downloaded on a phone, often on a slow link.
 */

import type { RegionFileName, StateCode } from './places';

export const CONTRACT_VERSION = 1;

/** Normalized program kind; a listing whose type is prose or empty carries none. */
export const KINDS = [
	'internship',
	'job-training',
	'skills-training',
	'apprenticeship',
	'fellowship',
	'other'
] as const;
export type Kind = (typeof KINDS)[number];

/** The site's own length buckets, in days; a listing that states none carries none. */
export const DURATIONS = [
	'1-30',
	'31-60',
	'61-90',
	'91-120',
	'121-150',
	'151-180',
	'180+'
] as const;
export type Duration = (typeof DURATIONS)[number];

/**
 * The site's delivery method ids, as its own "Find a SkillBridge Opportunity" filter labels them: 1 "In-Person",
 * 2 "Online", 3 "Hybrid (Online & In-Person)". On the 1,435-listing sample every one of the 323 listings filed under
 * "Virtual" carries 2, and 1 and 3 always carry a place.
 */
export const DELIVERY = { inPerson: 1, remote: 2, hybrid: 3 } as const;
export type Delivery = (typeof DELIVERY)[keyof typeof DELIVERY];

export const BRANCHES = [
	'Air Force',
	'Army',
	'Coast Guard',
	'Marine Corps',
	'Navy',
	'Space Force'
] as const;
export type Branch = (typeof BRANCHES)[number];

/** The 24 official industry names from the site's filter list (four contain commas: never split on them). */
export const INDUSTRIES = [
	'Architecture and Engineering',
	'Arts, Design, Entertainment, Sports, and Media',
	'Building and Grounds Cleaning and Maintenance',
	'Business and Financial Operations',
	'Community and Social Service',
	'Computer and Mathematical',
	'Construction and Extraction',
	'Educational Instruction and Library',
	'Farming, Fishing, and Forestry',
	'Food Preparation and Serving Related',
	'Healthcare Practitioners and Technical',
	'Healthcare Support',
	'Installation, Maintenance, and Repair',
	'Legal',
	'Life, Physical, and Social Science',
	'Management',
	'Military Specific',
	'Not Selected',
	'Office and Administrative Support',
	'Personal Care and Service',
	'Production',
	'Protective Service',
	'Sales and Related',
	'Transportation and Material Moving'
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const CAPS = {
	organization: 150,
	program: 200,
	city: 80,
	installation: 150,
	roleItem: 80,
	roleWords: 6,
	roles: 20,
	codes: 40,
	email: 254,
	url: 300
} as const;

export const MAX_LISTINGS_PER_FILE = 20_000;
/** Every list of ids in `ids.json` and `changes.json`; the whole site lists about 12,000. */
export const MAX_IDS = 200_000;
/**
 * The most bytes a client reads from any one data file, enforced while the body streams in, before it is
 * parsed: the row caps above only bound work after a file has already been read whole.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Two weeks of changes are published: this week's and last week's. */
export const MAX_CHANGE_WEEKS = 2;

export type Listing = {
	/** Listing id on skillbridge.mil. */
	i: number;
	/** Organization id. */
	o: number;
	/** Organization name. */
	n: string;
	/** Program title. */
	p: string;
	k?: Kind;
	c?: string;
	/** The listing's own state; absent for remote listings and unusable values. */
	s?: StateCode;
	/** Every state the listing names. */
	ls?: StateCode[];
	/** Five-digit ZIP. */
	z?: string;
	/** Latitude and longitude, both or neither. */
	la?: number;
	lo?: number;
	d?: Duration;
	m: Delivery;
	/** Branches the listing names; empty when it names none. */
	b: Branch[];
	/** Short role names, only where every item is a short name, not prose. */
	r?: string[];
	ind: Industry[];
	/** Occupation codes the company listed, or 'all' when it lists all; absent when it lists none. */
	oc?: string[] | 'all';
	dib: boolean;
	/** Date the listing was created on skillbridge.mil. */
	dc: string;
	/** Pull date on which we first saw it. */
	fl: string;
	/** Contact email as DoD lists it publicly; never together with `u`. */
	e?: string;
	/** An https form link given in place of an email. */
	u?: string;
	/** The company website, only when confirmed at publish. */
	w?: string;
	/** LinkedIn company page, only from Wikidata. */
	li?: string;
	/** Installation named by the listing. */
	inst?: string;
};

export type RegionFile = { v: 1; pullDate: string; file: RegionFileName; listings: Listing[] };

export type IndexFile = {
	v: 1;
	pullDate: string;
	/** True on the first full pull, whose listings are never New. */
	baseline: boolean;
	baselineDate: string;
	files: { name: RegionFileName; count: number; bytes: number }[];
};

/** Every current id with its first-listed pull date, and merged ids pointing at the id they merged into. */
export type IdsFile = {
	v: 1;
	pullDate: string;
	ids: [number, string][];
	aliases: [number, number][];
};

export type ChangesFile = {
	v: 1;
	weeks: { pullDate: string; added: number[]; removed: number[]; newOrgs: number[] }[];
};
