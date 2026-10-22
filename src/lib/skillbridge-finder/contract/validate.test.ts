import { describe, it, expect } from 'vitest';
import {
	validateChanges,
	validateIds,
	validateIndex,
	validateListing,
	validateRegionFile
} from './validate';
import { MAX_LISTINGS_PER_FILE } from './listing';

const ZERO_WIDTH = String.fromCharCode(0x200b);
const EN_DASH = String.fromCharCode(0x2013);
const FULLWIDTH_A = String.fromCharCode(0xff21);

function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		i: 386,
		o: 297,
		n: 'Example Training Co',
		p: 'Field Technician Internship',
		k: 'internship',
		c: 'Columbia',
		s: 'MD',
		ls: ['MD', 'VA'],
		z: '21046',
		la: 39.2,
		lo: -76.86,
		d: '91-120',
		m: 1,
		b: ['Navy', 'Army'],
		r: ['Field Technician', 'Wind Turbine Technician'],
		ind: ['Installation, Maintenance, and Repair'],
		oc: ['91B', '2A6X1', 'EM'],
		dib: true,
		dc: '2026-07-24',
		fl: '2026-10-21',
		e: 'skillbridge@example.com',
		w: 'https://example.com/',
		...overrides
	};
}

const codes = (raw: unknown) => validateListing(raw).map((e) => e.code);

describe('validateListing', () => {
	it('accepts a full record, and a bare one with only the required facts', () => {
		expect(validateListing(listing())).toEqual([]);
		expect(
			validateListing({
				i: 1,
				o: 2,
				n: 'A',
				p: 'B',
				m: 2,
				b: [],
				ind: [],
				dib: false,
				dc: '2026-01-01',
				fl: '2026-10-21'
			})
		).toEqual([]);
	});

	it.each(['i', 'o', 'n', 'p', 'm', 'b', 'ind', 'dib', 'dc', 'fl'])('requires %s', (field) => {
		const raw = listing();
		delete raw[field];
		const expected =
			field === 'i' ? { code: 'E_SBF_MISSING', field } : { code: 'E_SBF_MISSING', id: 386, field };
		expect(validateListing(raw)).toContainEqual(expected);
	});

	// Facts only: the published files never carry the provider's prose or the contact's name.
	it.each([
		'summary',
		'jobDescription',
		'otherEligibilityFactors',
		'employerPoc',
		'moUs',
		'natSec'
	])('refuses the dropped field %s', (field) => {
		expect(validateListing(listing({ [field]: 'x' }))).toContainEqual({
			code: 'E_SBF_UNKNOWN_FIELD',
			id: 386,
			field
		});
	});

	it.each([
		['n', 150],
		['p', 200]
	])('caps %s at %i characters', (field, cap) => {
		expect(validateListing(listing({ [field]: 'a'.repeat(cap) }))).toEqual([]);
		expect(codes(listing({ [field]: 'a'.repeat(cap + 1) }))).toEqual(['E_SBF_TOO_LONG']);
	});

	it.each([
		['k', 'Internship Program'],
		['d', '91 - 120 days'],
		['m', 4],
		['s', 'Virtual'],
		['s', 'NA'],
		['ls', ['TX', 'ALL']],
		['ls', ['TX', 'TX']],
		['r', []],
		['oc', []],
		['oc', ['12T 12Y']],
		['lo', 181],
		['b', ['Navy', 'Unknown']],
		['ind', ['Installation, Maintenance, and Repair and Construction and Extraction']],
		['oc', ['All MOCs']],
		['oc', 'any'],
		['dib', 'true'],
		['i', 0],
		['o', 1.5],
		['dc', '2026-02-30'],
		['fl', '2026-10-21T00:00:00'],
		['z', '2104'],
		['la', 91]
	])('refuses %s = %j', (field, value) => {
		expect(codes(listing({ [field]: value })).length).toBeGreaterThan(0);
		expect(validateListing(listing({ [field]: value }))[0]?.field).toBe(field);
	});

	it('accepts "all" as the open-to-all occupation marker', () => {
		expect(validateListing(listing({ oc: 'all' }))).toEqual([]);
	});

	// Hostile text measured in the sample: HTML, zero-width and look-alike characters, padded values.
	it.each([
		['n', 'Acme <b>Corp</b>'],
		['p', 'Intern' + ZERO_WIDTH + 'ship'],
		['c', ' Columbia'],
		['c', FULLWIDTH_A + 'ustin'],
		['r', ['Field Technician', 'Tech <i>Lead</i>']],
		['inst', 'Fort Example <a href=x>'],
		['n', '']
	])('refuses unsafe text in %s: %j', (field, value) => {
		expect(codes(listing({ [field]: value }))).toEqual(['E_SBF_BAD_TEXT']);
	});

	it.each([
		[['one two three four five six seven']],
		[['Role: Technician']],
		[['Technician - Level 1']],
		[[`Technician ${EN_DASH} Level 1`]],
		[Array.from({ length: 21 }, (_, n) => `Role ${n}`)]
	])('refuses a role list that reads as prose: %j', (roles) => {
		expect(codes(listing({ r: roles }))).toEqual(['E_SBF_BAD_ROLES']);
	});

	it('caps occupation codes at 40', () => {
		const forty = Array.from({ length: 40 }, (_, n) => `A${n}`);
		expect(validateListing(listing({ oc: forty }))).toEqual([]);
		expect(codes(listing({ oc: [...forty, 'B1'] }))).toEqual(['E_SBF_BAD_CODES']);
	});

	it.each([
		[{ e: 'a@example.com, b@example.com' }],
		[{ e: 'jobs@example.com?subject=hi' }],
		[{ e: 'https://forms.example.com/apply' }],
		[{ u: 'http://forms.example.com/apply' }],
		[{ u: 'https://user:pw@forms.example.com/apply' }],
		[{ e: undefined, u: 'javascript:alert(1)' }],
		[{ u: 'https://forms.example.com/apply' }],
		[{ w: 'https://example.com/careers' }],
		[{ w: 'https://recruiting.army.mil/' }],
		[{ w: 'https://www.va.gov/' }],
		[{ li: 'https://www.linkedin.com.example.com/company/x' }],
		[{ li: 'https://www.linkedin.com/in/a-person' }]
	])('refuses the contact or link %j', (overrides) => {
		expect(codes(listing(overrides)).length).toBeGreaterThan(0);
	});

	it('accepts an https form link in place of an email, and a LinkedIn company page', () => {
		expect(
			validateListing(
				listing({
					e: undefined,
					u: 'https://forms.example.com/apply',
					li: 'https://www.linkedin.com/company/example-co'
				})
			)
		).toEqual([]);
	});

	it('refuses a point with one coordinate missing', () => {
		expect(codes(listing({ lo: undefined }))).toEqual(['E_SBF_BAD_POINT']);
	});

	it('names no field it did not check when the input is not an object', () => {
		expect(validateListing(null)).toEqual([{ code: 'E_SBF_NOT_OBJECT' }]);
		expect(validateListing([listing()])).toEqual([{ code: 'E_SBF_NOT_OBJECT' }]);
	});
});

describe('validateRegionFile', () => {
	const file = (overrides: Record<string, unknown> = {}) => ({
		v: 1,
		pullDate: '2026-10-21',
		file: 'south-atlantic',
		listings: [listing(), listing({ i: 387 })],
		...overrides
	});

	it('accepts a well-formed file', () => {
		expect(validateRegionFile(file())).toEqual({ valid: true, errors: [] });
	});

	it('refuses an off-list file name, a future version and a bad pull date', () => {
		expect(validateRegionFile(file({ file: 'maryland' })).errors).toContainEqual({
			code: 'E_SBF_BAD_FILE_NAME',
			field: 'file'
		});
		expect(validateRegionFile(file({ v: 2 })).errors).toContainEqual({
			code: 'E_SBF_BAD_VERSION',
			field: 'v'
		});
		expect(validateRegionFile(file({ pullDate: 'last week' })).errors).toContainEqual({
			code: 'E_SBF_BAD_DATE',
			field: 'pullDate'
		});
	});

	it('refuses a duplicate id and carries a bad listing up with its id', () => {
		expect(validateRegionFile(file({ listings: [listing(), listing()] })).errors).toEqual([
			{ code: 'E_SBF_DUP_ID', id: 386, field: 'i' }
		]);
		expect(
			validateRegionFile(file({ listings: [listing({ i: 9, summary: 'prose' })] })).errors
		).toEqual([{ code: 'E_SBF_UNKNOWN_FIELD', id: 9, field: 'summary' }]);
	});

	it('refuses more rows than the cap without walking them', () => {
		const rows = new Array<unknown>(MAX_LISTINGS_PER_FILE + 1).fill(null);
		expect(validateRegionFile(file({ listings: rows })).errors).toEqual([
			{ code: 'E_SBF_TOO_MANY_ROWS', field: 'listings' }
		]);
	});
});

describe('validateIndex', () => {
	const index = (overrides: Record<string, unknown> = {}) => ({
		v: 1,
		pullDate: '2026-10-21',
		baseline: false,
		baselineDate: '2026-10-14',
		files: [
			{ name: 'pacific', count: 812, bytes: 401233 },
			{ name: 'remote', count: 1500, bytes: 758000 }
		],
		...overrides
	});

	it('accepts a well-formed index, and a baseline whose date is its own pull', () => {
		expect(validateIndex(index())).toEqual({ valid: true, errors: [] });
		expect(validateIndex(index({ baseline: true, baselineDate: '2026-10-21' }))).toEqual({
			valid: true,
			errors: []
		});
	});

	it.each([
		[{ files: [{ name: 'texas', count: 1, bytes: 1 }] }, 'E_SBF_BAD_FILE_NAME'],
		[
			{
				files: [
					{ name: 'remote', count: 1, bytes: 1 },
					{ name: 'remote', count: 1, bytes: 1 }
				]
			},
			'E_SBF_DUP_FILE'
		],
		[{ files: [{ name: 'remote', count: -1, bytes: 1 }] }, 'E_SBF_BAD_COUNT'],
		[{ baselineDate: '2026-10-28' }, 'E_SBF_BAD_DATE'],
		[{ baseline: true, baselineDate: '2026-10-14' }, 'E_SBF_BAD_DATE'],
		[{ baseline: 'no' }, 'E_SBF_BAD_TYPE']
	])('refuses %j with %s', (overrides, code) => {
		expect(validateIndex(index(overrides)).errors.map((e) => e.code)).toContain(code);
	});
});

describe('validateIds', () => {
	const ids = (overrides: Record<string, unknown> = {}) => ({
		v: 1,
		pullDate: '2026-10-21',
		ids: [
			[386, '2026-10-14'],
			[387, '2026-10-21']
		],
		aliases: [[901, 386]],
		...overrides
	});

	it('accepts a well-formed id list', () => {
		expect(validateIds(ids())).toEqual({ valid: true, errors: [] });
	});

	it.each([
		[{ ids: [[386, '2026-10-28']] }, 'E_SBF_BAD_DATE'],
		[{ ids: [['386', '2026-10-14']] }, 'E_SBF_BAD_ID'],
		[
			{
				ids: [
					[386, '2026-10-14'],
					[386, '2026-10-21']
				]
			},
			'E_SBF_DUP_ID'
		],
		[{ aliases: [[901, 999]] }, 'E_SBF_BAD_ALIAS'],
		[{ aliases: [[386, 386]] }, 'E_SBF_BAD_ALIAS']
	])('refuses %j with %s', (overrides, code) => {
		expect(validateIds(ids(overrides)).errors.map((e) => e.code)).toContain(code);
	});
});

describe('validateChanges', () => {
	const changes = (overrides: Record<string, unknown> = {}) => ({
		v: 1,
		weeks: [
			{ pullDate: '2026-10-21', added: [387], removed: [12], newOrgs: [9001] },
			{ pullDate: '2026-10-14', added: [], removed: [], newOrgs: [] }
		],
		...overrides
	});

	it('accepts this week and last, newest first', () => {
		expect(validateChanges(changes())).toEqual({ valid: true, errors: [] });
	});

	it.each([
		[
			{
				weeks: [
					{ pullDate: '2026-10-14', added: [], removed: [], newOrgs: [] },
					{ pullDate: '2026-10-21', added: [], removed: [], newOrgs: [] }
				]
			},
			'E_SBF_BAD_ORDER'
		],
		[
			{
				weeks: Array.from({ length: 3 }, (_, n) => ({
					pullDate: `2026-10-0${n + 1}`,
					added: [],
					removed: [],
					newOrgs: []
				}))
			},
			'E_SBF_TOO_MANY_ROWS'
		],
		[
			{ weeks: [{ pullDate: '2026-10-21', added: [1.5], removed: [], newOrgs: [] }] },
			'E_SBF_BAD_ID'
		]
	])('refuses %j with %s', (overrides, code) => {
		expect(validateChanges(changes(overrides)).errors.map((e) => e.code)).toContain(code);
	});
});
