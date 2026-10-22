import { describe, expect, it } from 'vitest';
import { validateInner } from '../../backup/validate';
import { encodeProfile } from '../../profile/codec';
import { encodeEaos, parseEaosAtRead } from '../../profile/eaos';
import { decodeFinderRecord } from './codec';

// A saved finder record and a backup file hold values for as long as the person keeps them, and a file made today may be
// restored years from now. So every value the finder has ever accepted must stay accepted, or a person's saved programs
// stop loading and their backup stops restoring. The lists and the maximal listing below are FROZEN copies of what has
// shipped: never edit one to remove a value or to make a case smaller. A value or a rule that has to go needs a
// migration for what is already stored, and this test is where the need shows: it goes red the moment the contract, the
// record codec or the backup check stops accepting any of them. A new value is added here with the release that adds it.

const SHIPPED_INDUSTRIES = [
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
];
const SHIPPED_BRANCHES = [
	'Air Force',
	'Army',
	'Coast Guard',
	'Marine Corps',
	'Navy',
	'Space Force'
];
const SHIPPED_DURATIONS = ['1-30', '31-60', '61-90', '91-120', '121-150', '151-180', '180+'];
const SHIPPED_KINDS = [
	'internship',
	'job-training',
	'skills-training',
	'apprenticeship',
	'fellowship',
	'other'
];
// The site's delivery ids: 1 in person, 2 online, 3 hybrid.
const SHIPPED_DELIVERY = [1, 2, 3];
const SHIPPED_RADII = [25, 50, 100, 'any'];
const SHIPPED_STATE_CODES = [
	'AK',
	'AL',
	'AR',
	'AS',
	'AZ',
	'CA',
	'CO',
	'CT',
	'DC',
	'DE',
	'FL',
	'GA',
	'GU',
	'HI',
	'IA',
	'ID',
	'IL',
	'IN',
	'KS',
	'KY',
	'LA',
	'MA',
	'MD',
	'ME',
	'MI',
	'MN',
	'MO',
	'MP',
	'MS',
	'MT',
	'NC',
	'ND',
	'NE',
	'NH',
	'NJ',
	'NM',
	'NV',
	'NY',
	'OH',
	'OK',
	'OR',
	'PA',
	'PR',
	'RI',
	'SC',
	'SD',
	'TN',
	'TX',
	'UT',
	'VA',
	'VI',
	'VT',
	'WA',
	'WI',
	'WV',
	'WY'
];
// The most the finder ever kept: programs saved, programs picked to compare.
const SHIPPED_MAX_SAVED = 200;
const SHIPPED_MAX_COMPARE = 3;

// One program with every field present, each text at its longest. The two ways to reach the provider cannot both be
// present, so the program that names a link instead of an address is the same program with those two fields swapped.
const text = (letter: string, length: number): string => letter.repeat(length);
// Six words and 80 characters, the longest a role may be; the first letter tells the 20 roles apart.
const role = (n: number): string => {
	const letter = String.fromCharCode(97 + n);
	return [
		text(letter, 13),
		text('a', 13),
		text('a', 13),
		text('a', 13),
		text('a', 13),
		text('a', 10)
	].join(' ');
};
const EVERY_FIELD_BUT_CONTACT = {
	i: 4_294_967_295,
	o: 4_294_967_294,
	n: text('N', 150),
	p: text('P', 200),
	k: 'apprenticeship',
	c: text('C', 80),
	s: 'WY',
	ls: SHIPPED_STATE_CODES,
	z: '00501',
	la: -90,
	lo: 180,
	d: '180+',
	m: 3,
	b: SHIPPED_BRANCHES,
	r: Array.from({ length: 20 }, (_, n) => role(n)),
	ind: SHIPPED_INDUSTRIES,
	oc: Array.from({ length: 40 }, (_, n) => `1511${String(n).padStart(2, '0')}`),
	dib: true,
	dc: '2000-02-29',
	fl: '2026-10-21',
	w: 'https://www.example.com/',
	li: 'https://www.linkedin.com/company/example-co/',
	inst: text('I', 150)
};
const MAXIMAL_LISTING = { ...EVERY_FIELD_BUT_CONTACT, e: text('e', 242) + '@example.com' };
const LINK_LISTING = {
	...EVERY_FIELD_BUT_CONTACT,
	i: 4_294_967_293,
	oc: 'all',
	u: 'https://example.com/' + text('u', 280)
};

const TODAY = '2026-10-21';

function profile(): Record<string, unknown> {
	return JSON.parse(
		new TextDecoder().decode(
			encodeProfile({
				schemaVersion: 1,
				generation: 3,
				lastSeenAt: 1_760_000_000_000,
				setupIntent: 'completed',
				setupIntentChangedAt: 1_759_000_000_000,
				eaos: encodeEaos(parseEaosAtRead('2027-06-30'))
			})
		)
	) as Record<string, unknown>;
}

/** A finder record holding the given parts, with nothing else in it. */
const record = (parts: Record<string, unknown> = {}): Record<string, unknown> => ({
	schemaVersion: 1,
	finderSaved: [],
	finderCompare: [],
	...parts
});

/** A program of the smallest shape the contract allows, to fill the lists to their ends. */
const smallListing = (i: number) => ({
	i,
	o: 1,
	n: 'Example Training Co',
	p: 'Field Technician Internship',
	m: 1,
	b: [],
	ind: [],
	dib: false,
	dc: '2026-01-01',
	fl: TODAY
});

/** The record is read back whole by the codec that opens a stored record, and passes the check a restore runs. */
function expectReadable(finder: Record<string, unknown>, what: string): void {
	const bytes = new TextEncoder().encode(JSON.stringify(finder));
	// Wrapped, so a value that no longer reads is an assertion saying which, not a bare throw.
	expect(() => decodeFinderRecord(bytes), `the stored record with ${what}`).not.toThrow();
	expect(decodeFinderRecord(bytes)).toEqual(finder);

	const file = JSON.parse(
		JSON.stringify({
			backupSchema: 1,
			appVersion: __APP_VERSION__,
			createdAt: 1_760_000_000_000,
			stores: {
				profile: profile(),
				'timeline-state': null,
				'calendar-sync': null,
				'skillbridge-finder': finder
			}
		})
	) as unknown;
	const result = validateInner(file);
	expect(result.ok, `the backup with ${what}`).toBe(true);
	if (result.ok) expect(result.inner.stores['skillbridge-finder']).toEqual(finder);
}

describe('a saved finder record and a backup stay readable as the contract changes', () => {
	it.each([
		['industries', SHIPPED_INDUSTRIES],
		['branches', SHIPPED_BRANCHES],
		['durations', SHIPPED_DURATIONS],
		['kinds', SHIPPED_KINDS],
		['delivery', SHIPPED_DELIVERY]
	] as [string, unknown[]][])('a filter on every shipped value of %s', (key, values) => {
		expectReadable(record({ finderFilters: { [key]: values } }), `every shipped ${key} value`);
	});

	it('every shipped state code, as the place a person looked in', () => {
		for (const state of SHIPPED_STATE_CODES) {
			expectReadable(
				record({ finderSetup: { place: { kind: 'state', state } } }),
				`the state ${state} as the place`
			);
		}
	});

	it('every shipped reach, with a ZIP place and both switches on', () => {
		for (const radius of SHIPPED_RADII) {
			expectReadable(
				record({
					finderSetup: {
						place: { kind: 'zip', zip: '00501' },
						radius,
						territories: true,
						overseas: true
					}
				}),
				`the reach ${String(radius)}`
			);
		}
	});

	it('the maximal saved listing, and its twin that names a link and every occupation code', () => {
		expectReadable(
			record({
				finderSaved: [
					{ id: MAXIMAL_LISTING.i, savedOn: TODAY, facts: MAXIMAL_LISTING },
					{ id: LINK_LISTING.i, savedOn: TODAY, facts: LINK_LISTING }
				],
				finderCompare: [MAXIMAL_LISTING.i, LINK_LISTING.i]
			}),
			'the maximal saved listing'
		);
	});

	it('the most programs saved and the most picked to compare', () => {
		expectReadable(
			record({
				finderSaved: Array.from({ length: SHIPPED_MAX_SAVED }, (_, n) => ({
					id: n + 1,
					savedOn: TODAY,
					facts: smallListing(n + 1)
				})),
				finderCompare: Array.from({ length: SHIPPED_MAX_COMPARE }, (_, n) => n + 1)
			}),
			'the most programs saved and picked'
		);
	});
});
