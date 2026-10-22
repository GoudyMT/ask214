import { describe, expect, it } from 'vitest';
import { cleanListings, type Box, type PlaceLookups } from './clean-core.ts';
import type { CleanListing, CleanOutput } from './types.ts';
import type { ApiListing } from '../../src/lib/skillbridge-finder/contract/api.ts';
import {
	STATE_CODES,
	TERRITORY_CODES,
	type StateCode
} from '../../src/lib/skillbridge-finder/contract/places.ts';
import { validateListing } from '../../src/lib/skillbridge-finder/contract/validate.ts';
import { RAW_CASES, rawListing } from '../../src/lib/skillbridge-finder/fixtures/raw.ts';

// Small synthetic lookups: the real boxes and centroids come from the Census tables.
const BOXES: Partial<Record<StateCode, Box>> = {
	MD: [37.8, -79.6, 39.8, -75.0],
	MA: [41.2, -73.6, 42.9, -69.9],
	AK: [51.0, -170.0, 72.0, -129.0],
	PR: [17.8, -67.5, 18.6, -65.1]
};
const ZIP_POINTS: Record<string, readonly [number, number]> = { '21046': [39.19, -76.85] };
const PLACES: PlaceLookups = {
	stateBox: (code) => BOXES[code],
	zipPoint: (zip) => ZIP_POINTS[zip]
};
const CENTROID = { la: 39.19, lo: -76.85 };

function clean(
	rows: readonly ApiListing[],
	options: { suppression?: string[]; places?: PlaceLookups } = {}
): CleanOutput {
	return cleanListings(rows, {
		suppression: new Set(options.suppression ?? []),
		places: options.places ?? PLACES
	});
}

/** The one published listing of a one-row run; fails loudly when the row was held back. */
function only(overrides: Partial<ApiListing>, suppression: string[] = []): CleanListing {
	const out = clean([rawListing(overrides)], { suppression });
	const [listing] = out.listings;
	if (listing === undefined || out.listings.length !== 1) throw new Error('E_TEST_NOT_PUBLISHED');
	return listing;
}

/** What `rawListing()` cleans to; each expectation changes only what its case is about. */
const BASE: CleanListing = {
	i: 1001,
	o: 301,
	n: 'Example Wind Services',
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
	b: ['Army', 'Navy'],
	r: ['Field Technician', 'Wind Turbine Technician'],
	ind: ['Installation, Maintenance, and Repair'],
	oc: ['91B', '2A6X1', 'EM'],
	dib: false,
	dc: '2026-07-24',
	e: 'skillbridge@example.com'
};

function want(
	change: Partial<CleanListing> = {},
	remove: readonly (keyof CleanListing)[] = []
): CleanListing {
	const out: Record<string, unknown> = { ...BASE, ...change };
	for (const key of remove) delete out[key];
	return out as CleanListing;
}

const ALL_STATES = STATE_CODES.filter((code) => !TERRITORY_CODES.includes(code));
const CURLY_APOSTROPHE = String.fromCharCode(0x2019);
const EN_DASH = String.fromCharCode(0x2013);

type Want = { listing: CleanListing; dropped?: Record<string, number> } | { quarantine: string };

// One expectation per measured bad shape in RAW_CASES (ids 1002-1040), each the output of that row alone.
const EXPECT: Record<keyof typeof RAW_CASES, Want> = {
	flippedLongitude: { listing: want(CENTROID), dropped: { P_ZIP_CENTROID: 1 } },
	nullIsland: { listing: want(CENTROID), dropped: { P_ZIP_CENTROID: 1 } },
	guamFiledUnderAlaska: {
		listing: want({ c: 'Hagatna', s: 'AK', z: '96910' }, ['la', 'lo']),
		dropped: { D_POINT: 1 }
	},
	virtualState: {
		listing: want({ m: 2 }, ['c', 's', 'ls', 'z', 'la', 'lo']),
		dropped: { D_POINT: 1 }
	},
	stateNA: { listing: want(CENTROID, ['s']), dropped: { D_STATE: 1, P_ZIP_CENTROID: 1 } },
	zipMissingLeadingZero: {
		listing: want({ c: 'Boston', s: 'MA', z: '02134', la: 42.35, lo: -71.13 })
	},
	twoEmails: { listing: want({ e: 'jobs@example.com' }) },
	urlAsEmail: { listing: want({ u: 'https://forms.example.com/apply' }, ['e']) },
	httpUrlAsEmail: { listing: want({}, ['e']), dropped: { D_EMAIL: 1 } },
	spacedEmail: { listing: want({ e: 'jobs@example.com' }) },
	emailWithQuery: { listing: want({}, ['e']), dropped: { D_EMAIL: 1 } },
	tenPlusStates: {
		listing: want({
			ls: ['AK', 'AL', 'AZ', 'CA', 'CO', 'FL', 'GA', 'HI', 'MD', 'NC', 'TX', 'VA', 'WA']
		})
	},
	allStates: { listing: want({ ls: ALL_STATES }) },
	proseStates: { listing: want({ ls: ['MD'] }) },
	// TX has no box in these lookups, so the raw point cannot be checked and the ZIP centroid stands in.
	stateOutsideItsList: {
		listing: want({ s: 'TX', ...CENTROID }),
		dropped: { P_ZIP_CENTROID: 1 }
	},
	htmlInProgram: { quarantine: 'E_Q_PROGRAM' },
	zeroWidthInName: { listing: want() },
	privateUseInCity: { listing: want() },
	bidiOverride: { listing: want({ p: 'Technician Internship' }) },
	paddedName: { listing: want() },
	curlyApostrophe: { listing: want({ n: 'Example' + CURLY_APOSTROPHE + 's Wind Services' }) },
	proseRoles: { listing: want({}, ['r']), dropped: { D_ROLES: 1 } },
	rolesWithParentheses: {
		listing: want({ r: ['Technician (Electrical, Mechanical)', 'Inspector'] })
	},
	allOccupations: { listing: want({ oc: 'all' }) },
	proseOccupations: { listing: want({}, ['oc']), dropped: { D_CODES: 1 } },
	codesWithNames: { listing: want({ oc: ['91B', 'EM'] }) },
	industryAlias: { listing: want({ ind: ['Educational Instruction and Library'] }) },
	industryOtherProse: { listing: want({ ind: [] }), dropped: { D_INDUSTRY_OTHER: 1 } },
	industriesJoinedByAnd: {
		listing: want({ ind: ['Construction and Extraction', 'Installation, Maintenance, and Repair'] })
	},
	noIndustry: { listing: want({ ind: [] }) },
	unknownBranches: { listing: want({ b: [] }), dropped: { D_BRANCH: 1 } },
	proseProgramType: { listing: want({}, ['k']), dropped: { D_KIND: 1 } },
	emptyProgramType: { listing: want({}, ['k']) },
	emptyDuration: { listing: want({}, ['d']) },
	nullInstallation: { listing: want() },
	longInstallation: { listing: want(), dropped: { D_INSTALLATION: 1 } },
	territory: {
		listing: want({ c: 'San Juan', s: 'PR', z: '00901', la: 18.46, lo: -66.1, ls: ['PR'] })
	},
	hybrid: { listing: want({ m: 3 }) },
	duplicateContent: { listing: want() }
};

describe('every measured bad shape', () => {
	// A case added to the fixtures without an expectation here would otherwise go unchecked.
	it('has an expectation for each fixture case and no other', () => {
		expect(Object.keys(EXPECT).sort()).toEqual(Object.keys(RAW_CASES).sort());
	});

	for (const key of Object.keys(RAW_CASES) as (keyof typeof RAW_CASES)[]) {
		it(key, () => {
			const raw = RAW_CASES[key];
			const out = clean([raw]);
			const expected = EXPECT[key];
			expect(out.aliases).toEqual([]);
			if ('quarantine' in expected) {
				expect(out.listings).toEqual([]);
				expect(out.quarantine).toEqual([{ id: raw.id, code: expected.quarantine }]);
			} else {
				expect(out.quarantine).toEqual([]);
				expect(out.listings).toStrictEqual([{ ...expected.listing, i: raw.id }]);
				expect(out.dropped).toEqual(expected.dropped ?? {});
			}
		});
	}
});

describe('text fields', () => {
	it('joins a provider name written over several lines with single spaces', () => {
		expect(only({ organization: 'Example\tWind\n  Services' }).n).toBe('Example Wind Services');
	});

	it('folds look-alike letters to plain ones', () => {
		expect(only({ organization: String.fromCharCode(0xff25) + 'xample Wind Services' }).n).toBe(
			'Example Wind Services'
		);
	});

	it('holds back a program whose markup is hidden in look-alike angle brackets', () => {
		const program = String.fromCharCode(0xfe64) + 'b' + String.fromCharCode(0xfe65) + 'Internship';
		const out = clean([rawListing({ program })]);
		expect(out.listings).toEqual([]);
		expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_PROGRAM' }]);
	});

	it('holds back a row whose organization holds markup', () => {
		const out = clean([rawListing({ organization: 'Example <script>' })]);
		expect(out.listings).toEqual([]);
		expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_NAME' }]);
	});

	it('holds back a row whose organization is empty after cleaning', () => {
		const out = clean([rawListing({ organization: String.fromCharCode(0x200b) + '  ' })]);
		expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_NAME' }]);
	});

	it('keeps an organization of 150 characters and holds back one of 151', () => {
		expect(only({ organization: 'x'.repeat(150) }).n).toHaveLength(150);
		const out = clean([rawListing({ organization: 'x'.repeat(151) })]);
		expect(out.listings).toEqual([]);
		expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_NAME' }]);
	});

	it('keeps a program of 200 characters and holds back one of 201', () => {
		expect(only({ program: 'x'.repeat(200) }).p).toHaveLength(200);
		const out = clean([rawListing({ program: 'x'.repeat(201) })]);
		expect(out.listings).toEqual([]);
		expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_PROGRAM' }]);
	});

	it('drops a city holding markup but keeps the row', () => {
		const out = clean([rawListing({ city: 'Columbia<img>' })]);
		expect(out.quarantine).toEqual([]);
		expect(out.listings).toHaveLength(1);
		expect(out.listings[0]).not.toHaveProperty('c');
		expect(out.dropped).toEqual({ D_CITY: 1 });
	});

	// These characters render as empty space but are not control or format characters, so a name made of
	// them would pass as text while showing nothing.
	const BLANK_LOOKING = [0x115f, 0x1160, 0x2800, 0x3164, 0xffa0].map((code) =>
		String.fromCharCode(code)
	);

	it.each(BLANK_LOOKING.map((char) => [char.charCodeAt(0).toString(16), char]))(
		'holds back a name and a program made only of the blank-looking character U+%s',
		(_code, char) => {
			const name = clean([rawListing({ organization: char.repeat(3) })]);
			expect(name.listings).toEqual([]);
			expect(name.quarantine).toEqual([{ id: 1001, code: 'E_Q_NAME' }]);
			const program = clean([rawListing({ program: ' ' + char + ' ' })]);
			expect(program.quarantine).toEqual([{ id: 1001, code: 'E_Q_PROGRAM' }]);
		}
	);

	it('strips blank-looking characters from inside a name like any invisible one', () => {
		const filler = BLANK_LOOKING.join('');
		expect(only({ organization: 'Example' + filler + ' Wind Services' }).n).toBe(
			'Example Wind Services'
		);
	});

	// A letter stacked with a pile of combining marks draws over the lines around it ("zalgo" text).
	const marks = (n: number) => 'x' + String.fromCharCode(0x301, 0x302, 0x303, 0x304).slice(0, n);

	it('holds back a name or program with a run of more than two combining marks', () => {
		const name = clean([rawListing({ organization: 'Example ' + marks(3) })]);
		expect(name.quarantine).toEqual([{ id: 1001, code: 'E_Q_NAME' }]);
		const program = clean([rawListing({ program: 'Intern ' + marks(4) })]);
		expect(program.quarantine).toEqual([{ id: 1001, code: 'E_Q_PROGRAM' }]);
	});

	it('drops a city, an installation and a role holding stacked marks but keeps the row', () => {
		const out = clean([
			rawListing({
				city: 'Col' + marks(3),
				installation: 'Camp ' + marks(3),
				jobDescription: 'Inspector, Tech' + marks(3)
			})
		]);
		const [listing] = out.listings;
		expect(listing).not.toHaveProperty('c');
		expect(listing).not.toHaveProperty('inst');
		expect(listing).not.toHaveProperty('r');
		expect(out.dropped).toEqual({ D_CITY: 1, D_INSTALLATION: 1, D_ROLES: 1 });
	});

	it('keeps a letter with two combining marks, as real names have', () => {
		expect(only({ organization: 'Example ' + marks(2) }).n).toBe('Example ' + marks(2));
	});

	it('holds back a name or program with no letter or digit and drops such a city', () => {
		expect(clean([rawListing({ organization: '. . .' })]).quarantine).toEqual([
			{ id: 1001, code: 'E_Q_NAME' }
		]);
		expect(clean([rawListing({ program: '---' })]).quarantine).toEqual([
			{ id: 1001, code: 'E_Q_PROGRAM' }
		]);
		const out = clean([rawListing({ city: '???' })]);
		expect(out.listings[0]).not.toHaveProperty('c');
		expect(out.dropped).toEqual({ D_CITY: 1 });
	});
});

describe('very long values', () => {
	// Some of the cleaning is quadratic in the length of a value (nested parentheses are peeled one layer at a
	// time), and a provider can send as much text as it likes.
	const padded = (length: number) => 'Inspector' + ','.repeat(length - 'Inspector'.length);

	it('keeps roles from a value of 10,000 characters and refuses one of 10,001', () => {
		expect(only({ jobDescription: padded(10_000) }).r).toEqual(['Inspector']);
		const out = clean([rawListing({ jobDescription: padded(10_001) })]);
		expect(out.listings[0]).not.toHaveProperty('r');
		expect(out.dropped).toEqual({ D_ROLES: 1 });
	});

	it('refuses a 50,000-character value quickly', () => {
		const started = performance.now();
		const out = clean([
			rawListing({
				jobDescription: padded(50_000),
				targetMOCs: '('.repeat(25_000) + ')'.repeat(25_000)
			})
		]);
		expect(performance.now() - started).toBeLessThan(200);
		expect(out.listings[0]).not.toHaveProperty('r');
		expect(out.listings[0]).not.toHaveProperty('oc');
		expect(out.dropped).toEqual({ D_ROLES: 1, D_CODES: 1 });
	});

	it('holds back a row whose required name is that long', () => {
		const out = clean([rawListing({ organization: 'x'.repeat(10_001) })]);
		expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_NAME' }]);
	});
});

describe('required fields', () => {
	it('holds back a delivery method outside 1, 2 and 3', () => {
		const out = clean([rawListing({ deliveryMethodId: 4 })]);
		expect(out.listings).toEqual([]);
		expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_DELIVERY' }]);
	});

	it.each(['not a date', '2026-02-30T00:00:00', ''])(
		'holds back a creation date of %j',
		(dateCreated) => {
			const out = clean([rawListing({ dateCreated })]);
			expect(out.listings).toEqual([]);
			expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_DATE' }]);
		}
	);

	it('holds back a row whose disability-bridge flag is not a boolean', () => {
		const out = clean([rawListing({ dib: 'yes' as unknown as boolean })]);
		expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_DIB' }]);
	});

	it('holds back ids that are not positive whole numbers, and a row that is not an object', () => {
		const out = clean([
			rawListing({ id: 1.5 }),
			rawListing({ id: 1002, organizationId: 0 }),
			null as unknown as ApiListing
		]);
		expect(out.listings).toEqual([]);
		expect(out.quarantine).toEqual([
			{ id: 0, code: 'E_Q_ID' },
			{ id: 0, code: 'E_Q_ID' },
			{ id: 1002, code: 'E_Q_ID' }
		]);
	});

	it('holds back a row the validator would refuse, such as one given a corrupt ZIP centroid', () => {
		const corrupt: PlaceLookups = { ...PLACES, zipPoint: () => [95, 0] };
		const out = clean([rawListing({ lon: 76.86 })], { places: corrupt });
		expect(out.listings).toEqual([]);
		expect(out.quarantine).toEqual([{ id: 1001, code: 'E_Q_INVALID' }]);
	});

	it('does not count the optional values of a row it holds back', () => {
		const out = clean([rawListing({ deliveryMethodId: 4, zip: '123', state: 'NA' })]);
		expect(out.dropped).toEqual({});
	});
});

describe('places', () => {
	it.each(['VIRGINIA', 'HI-KUNIA HI-KIHEI', 'Located in Maryland or Virginia', ''])(
		'falls back to the listing state when locationStates is %j',
		(locationStates) => {
			expect(only({ locationStates }).ls).toEqual(['MD']);
		}
	);

	it.each([
		['MD OR VA', ['MD', 'VA']],
		['MD and VA', ['MD', 'VA']],
		['MD AND VA', ['MD', 'VA']],
		['MD & VA', ['MD', 'VA']],
		['OK to relocate to MD, VA', ['MD', 'VA']],
		// A plain comma list of codes keeps every one, including the codes that are also English words.
		['HI, ME, MD', ['HI', 'MD', 'ME']]
	])('reads the states in %j as %j', (locationStates, expected) => {
		expect(only({ locationStates }).ls).toEqual(expected);
	});

	it('falls back to the listing state for a sentence whose only codes are English words', () => {
		expect(only({ locationStates: 'REMOTE OR IN PERSON' }).ls).toEqual(['MD']);
	});

	it('reads ALL, in any case and with padding, as the 50 states and DC', () => {
		expect(ALL_STATES).toHaveLength(51);
		expect(only({ locationStates: ' all ' }).ls).toEqual(ALL_STATES);
	});

	it('splits locationStates on commas, semicolons and spaces, and drops repeats', () => {
		expect(only({ locationStates: 'VA;MD  VA,,TX' }).ls).toEqual(['MD', 'TX', 'VA']);
	});

	it('records an overseas listing and gives it no state', () => {
		const out = clean([rawListing({ id: 1500, state: 'OS' })]);
		expect(out.overseas).toEqual([1500]);
		expect(out.listings[0]).not.toHaveProperty('s');
		expect(out.dropped).not.toHaveProperty('D_STATE');
	});

	it('does not list a held-back overseas row as overseas', () => {
		const out = clean([rawListing({ id: 1500, state: 'OS', deliveryMethodId: 4 })]);
		expect(out.overseas).toEqual([]);
	});

	it.each([
		['21046', '21046'],
		['2134', '02134'],
		['21046-1234', '21046'],
		['210461234', '21046'],
		[' 21046 ', '21046']
	])('reads the ZIP %j as %j', (zip, expected) => {
		expect(only({ zip }).z).toBe(expected);
	});

	it.each(['123', '2104a', 'ABCDE', '210461', '2104-1234'])('drops the ZIP %j', (zip) => {
		const out = clean([rawListing({ zip })]);
		expect(out.listings[0]).not.toHaveProperty('z');
		expect(out.dropped).toEqual({ D_ZIP: 1 });
	});

	it('keeps a point on the edge of its state box', () => {
		expect(only({ lat: 37.8, lon: -79.6 })).toMatchObject({ la: 37.8, lo: -79.6 });
	});

	it('replaces a point outside its state box with the ZIP centroid', () => {
		expect(only({ lat: 13.47, lon: 144.75 })).toMatchObject(CENTROID);
	});

	it('gives a point outside its box and a ZIP with no centroid no point at all', () => {
		const out = clean([rawListing({ lat: 13.47, lon: 144.75, zip: '21047' })]);
		expect(out.listings[0]).not.toHaveProperty('la');
		expect(out.listings[0]).not.toHaveProperty('lo');
		expect(out.dropped).toEqual({ D_POINT: 1 });
	});

	it('does not trust a point past the range of the globe even if a box would hold it', () => {
		const wide: PlaceLookups = { ...PLACES, stateBox: () => [-500, -500, 500, 500] };
		const out = clean([rawListing({ lat: 95, lon: -76 })], { places: wide });
		expect(out.listings[0]).toMatchObject(CENTROID);
	});
});

describe('durations, kinds and branches', () => {
	it.each([
		['More than 180 days', '180+'],
		['31 - 60 days', '31-60'],
		['151 - 180 days', '151-180']
	])('reads the duration %j as %j', (duration, expected) => {
		expect(only({ duration }).d).toBe(expected);
	});

	it('drops a duration that is no bucket of the site', () => {
		const out = clean([rawListing({ duration: '5 - 7 days' })]);
		expect(out.listings[0]).not.toHaveProperty('d');
		expect(out.dropped).toEqual({ D_DURATION: 1 });
	});

	it.each([
		['Apprenticeship Program', 'apprenticeship'],
		['Paid Fellowship', 'fellowship'],
		['On-the-Job Training', 'job-training'],
		['OJT', 'job-training'],
		['Skills Training Program', 'skills-training'],
		['Internship and Apprenticeship', 'internship'],
		['Apprenticeship that leads to an internship', 'apprenticeship'],
		['Paid Interns Program', 'internship'],
		['Fellows Program', 'fellowship'],
		// "intern" opens many other words; only the whole words count as the kind.
		['International Skills Training', 'skills-training'],
		['Internet Skills Program', 'skills-training']
	])('reads the program type %j as %j', (programType, expected) => {
		expect(only({ programType }).k).toBe(expected);
	});

	it.each(['ojtx pilot', 'Internal Training Program', 'Fellowshipping 101'])(
		'does not read a kind into %j',
		(programType) => {
			const out = clean([rawListing({ programType })]);
			expect(out.listings[0]).not.toHaveProperty('k');
			expect(out.dropped).toEqual({ D_KIND: 1 });
		}
	);

	it('lists branches in the contract order, once each, and ignores the rest', () => {
		expect(only({ branches: ['Space Force', 'Army', 'Army', 'Air Force', 'Pirates'] }).b).toEqual([
			'Air Force',
			'Army',
			'Space Force'
		]);
	});
});

describe('roles, industries and occupation codes', () => {
	it('keeps 20 short roles and drops 21', () => {
		const roles = (n: number) => Array.from({ length: n }, (_, k) => `Role ${k + 1}`).join(', ');
		expect(only({ jobDescription: roles(20) }).r).toHaveLength(20);
		const out = clean([rawListing({ jobDescription: roles(21) })]);
		expect(out.listings[0]).not.toHaveProperty('r');
		expect(out.dropped).toEqual({ D_ROLES: 1 });
	});

	it.each([
		['Technician (Electrical, Inspector'],
		['one two three four five six seven'],
		['Technician - Level 1'],
		['Technician ' + EN_DASH + ' Level 1'],
		['Technician <b>'],
		['Inspector, ' + 'x'.repeat(81)],
		['Inspector, !!!']
	])('drops the roles %j as prose', (jobDescription) => {
		const out = clean([rawListing({ jobDescription })]);
		expect(out.listings[0]).not.toHaveProperty('r');
		expect(out.dropped).toEqual({ D_ROLES: 1 });
	});

	it('reads a line break between roles as a separator', () => {
		expect(
			only({ jobDescription: 'Field Technician\nWind Turbine Technician\r\nInspector' }).r
		).toEqual(['Field Technician', 'Wind Turbine Technician', 'Inspector']);
	});

	// A provider sometimes types "Ask for <contact>" where the roles go; the contact's name must not be published.
	it.each([['Ask for Pat Example, Technician'], ['Technician, ask for PAT'], ['Call example']])(
		'drops roles that name the contact: %j',
		(jobDescription) => {
			const out = clean([rawListing({ jobDescription, employerPoc: 'Pat Example' })]);
			expect(out.listings[0]).not.toHaveProperty('r');
			expect(out.dropped).toEqual({ D_ROLES_CONTACT: 1 });
			expect(JSON.stringify(out)).not.toContain('Pat Example');
		}
	);

	it('keeps roles that only share letters or a short word with the contact', () => {
		const roles = (jobDescription: string, employerPoc: string) =>
			only({ jobDescription, employerPoc }).r;
		expect(roles('Patrol Officer, Examples Clerk', 'Pat Example')).toEqual([
			'Patrol Officer',
			'Examples Clerk'
		]);
		expect(roles('Li Inspector, Welder', 'Jo Li')).toEqual(['Li Inspector', 'Welder']);
	});

	it('keeps the four industry names that hold commas whole', () => {
		const names = [
			'Arts, Design, Entertainment, Sports, and Media',
			'Farming, Fishing, and Forestry',
			'Installation, Maintenance, and Repair',
			'Life, Physical, and Social Science'
		];
		expect(only({ industries: names.join('; ') }).ind).toEqual([
			'Arts, Design, Entertainment, Sports, and Media',
			'Farming, Fishing, and Forestry',
			'Installation, Maintenance, and Repair',
			'Life, Physical, and Social Science'
		]);
	});

	it('finds names joined by "and" and keeps them in the contract order', () => {
		expect(only({ industries: 'Business and Financial Operations and Management ' }).ind).toEqual([
			'Business and Financial Operations',
			'Management'
		]);
	});

	it('counts an Other and an unrecognized segment, and keeps the names beside them', () => {
		const out = clean([rawListing({ industries: 'Healthcare Support; Other; Mystery Field' })]);
		expect(out.listings[0]?.ind).toEqual(['Healthcare Support']);
		expect(out.dropped).toEqual({ D_INDUSTRY_OTHER: 1, D_INDUSTRY_UNKNOWN: 1 });
	});

	it('does not find a name inside a longer word', () => {
		const out = clean([rawListing({ industries: 'Legalese' })]);
		expect(out.listings[0]?.ind).toEqual([]);
		expect(out.dropped).toEqual({ D_INDUSTRY_UNKNOWN: 1 });
	});

	it.each([
		['all', 'all'],
		['ALL', 'all'],
		['All MOCs', 'all'],
		['Allied Health', undefined],
		['', undefined],
		// "all" opens a sentence about one kind of job, which is not "open to all".
		['All-source analysts (35F)', undefined],
		// Words in capitals that fit the code shape are not codes.
		['ANY', undefined],
		['NONE', undefined],
		['MOS 11B', undefined],
		['11B OR 12B', undefined],
		['11B AND 12B', undefined],
		['OPEN', undefined],
		['TBD', undefined],
		['NA', undefined]
	])('reads the target MOCs %j', (targetMOCs, expected) => {
		const listing = only({ targetMOCs });
		if (expected === undefined) expect(listing).not.toHaveProperty('oc');
		else expect(listing.oc).toBe(expected);
	});

	it('keeps 40 codes, drops 41, and drops repeats', () => {
		const codes = (n: number) =>
			Array.from({ length: n }, (_, k) => `M${String(k).padStart(2, '0')}`);
		expect(only({ targetMOCs: codes(40).join(', ') }).oc).toHaveLength(40);
		const out = clean([rawListing({ targetMOCs: codes(41).join(', ') })]);
		expect(out.listings[0]).not.toHaveProperty('oc');
		expect(out.dropped).toEqual({ D_CODES: 1 });
		expect(only({ targetMOCs: '91B; EM 91B' }).oc).toEqual(['91B', 'EM']);
	});
});

describe('contacts', () => {
	it('drops an address on the suppression list, whatever its case', () => {
		const out = clean([rawListing({ employerPocEmail: 'SkillBridge@Example.com' })], {
			suppression: ['skillbridge@example.com']
		});
		expect(out.listings[0]).not.toHaveProperty('e');
		expect(out.listings[0]).not.toHaveProperty('u');
		expect(out.dropped).toEqual({ D_SUPPRESSED: 1 });
	});

	it.each([
		'https://user:secret@forms.example.com/apply',
		'https://forms.example.com./apply',
		'HTTP://forms.example.com/apply',
		'https://',
		'https://forms.example.com/' + 'a'.repeat(300),
		// A form on a raw address or an internal name is not a company's page a person should be sent to.
		'https://192.0.2.7/apply',
		'https://2130706433/apply',
		'https://[2001:db8::1]/apply',
		'https://intranet/apply',
		'https://localhost/apply'
	])('drops the link %j', (employerPocEmail) => {
		const out = clean([rawListing({ employerPocEmail })]);
		expect(out.listings[0]).not.toHaveProperty('e');
		expect(out.listings[0]).not.toHaveProperty('u');
		expect(out.dropped).toEqual({ D_EMAIL: 1 });
	});

	it('publishes the link in its normalized form, an international host as punycode', () => {
		expect(only({ employerPocEmail: 'HTTPS://Forms.Example.COM/Apply' }).u).toBe(
			'https://forms.example.com/Apply'
		);
		const host = 'm' + String.fromCharCode(0xfc) + 'nchen.example.com';
		expect(only({ employerPocEmail: 'https://' + host + '/form' }).u).toBe(
			'https://xn--mnchen-3ya.example.com/form'
		);
	});

	it('keeps no contact for a field that holds neither address nor link', () => {
		const out = clean([rawListing({ employerPocEmail: 'call the front desk' })]);
		expect(out.listings[0]).not.toHaveProperty('e');
		expect(out.dropped).toEqual({ D_EMAIL: 1 });
	});
});

describe('duplicates and order', () => {
	it('keeps the lowest id of listings that clean to the same facts, even when it comes last', () => {
		const out = clean([RAW_CASES.duplicateContent, RAW_CASES.paddedName, rawListing({ id: 1001 })]);
		expect(out.listings.map((l) => l.i)).toEqual([1001]);
		expect(out.aliases).toEqual([
			[1021, 1001],
			[1040, 1001]
		]);
	});

	it('does not merge listings that differ only in city and ZIP', () => {
		const out = clean([
			rawListing({ id: 1001 }),
			rawListing({ id: 1050, city: 'Laurel', zip: '20707' })
		]);
		expect(out.listings.map((l) => l.i)).toEqual([1001, 1050]);
		expect(out.aliases).toEqual([]);
	});

	it('does not merge an overseas listing with one whose state is unusable', () => {
		const out = clean([
			rawListing({ id: 1001, state: 'OS' }),
			rawListing({ id: 1002, state: 'NI' })
		]);
		expect(out.listings.map((l) => l.i)).toEqual([1001, 1002]);
		expect(out.overseas).toEqual([1001]);
	});

	it('lists only kept ids as overseas when copies merge', () => {
		const out = clean([
			rawListing({ id: 1002, state: 'OS' }),
			rawListing({ id: 1001, state: 'OS' })
		]);
		expect(out.aliases).toEqual([[1002, 1001]]);
		expect(out.overseas).toEqual([1001]);
	});

	it('sorts listings and overseas ids by id and held-back rows by id', () => {
		const out = clean([
			rawListing({ id: 1300, state: 'OS', city: 'A' }),
			rawListing({ id: 1200, state: 'OS', city: 'B' }),
			rawListing({ id: 1250, deliveryMethodId: 4 }),
			rawListing({ id: 1100, deliveryMethodId: 4 })
		]);
		expect(out.listings.map((l) => l.i)).toEqual([1200, 1300]);
		expect(out.overseas).toEqual([1200, 1300]);
		expect(out.quarantine.map((q) => q.id)).toEqual([1100, 1250]);
	});
});

describe('what leaves the PC', () => {
	const ALLOWED_KEYS = new Set([
		'i',
		'o',
		'n',
		'p',
		'k',
		'c',
		's',
		'ls',
		'z',
		'la',
		'lo',
		'd',
		'm',
		'b',
		'r',
		'ind',
		'oc',
		'dib',
		'dc',
		'e',
		'u',
		'inst'
	]);
	const planted = rawListing({
		id: 2001,
		summary: 'PLANTED-SUMMARY',
		employerPoc: 'PLANTED-NAME',
		other: 'PLANTED-OTHER',
		otherEligibilityFactors: 'PLANTED-ELIGIBILITY',
		jobDescription: 'PLANTED-JOBDESCRIPTION',
		installation: 'Camp Example'
	});
	const everyRow = [
		...Object.values(RAW_CASES),
		planted,
		rawListing({ id: 2002, state: 'OS' }),
		rawListing({ id: 2003, locationStates: 'VIRGINIA', zip: '123' }),
		rawListing({ id: 2004, program: 'x'.repeat(201) }),
		rawListing({ id: 2005, deliveryMethodId: 4 })
	];

	it('puts only contract keys on a listing and never the provider prose or contact name', () => {
		const out = clean(everyRow);
		expect(out.listings.length).toBeGreaterThan(20);
		for (const listing of out.listings)
			for (const key of Object.keys(listing)) expect(ALLOWED_KEYS.has(key)).toBe(true);
		const json = JSON.stringify(out);
		for (const value of ['PLANTED-SUMMARY', 'PLANTED-NAME', 'PLANTED-OTHER', 'PLANTED-ELIGIBILITY'])
			expect(json).not.toContain(value);
		expect(json).not.toContain('PLANTED-JOBDESCRIPTION');
		expect(json).toContain('Camp Example');
	});

	it('hands the validator nothing it refuses', () => {
		const out = clean(everyRow);
		const errors = out.listings.flatMap((listing) =>
			validateListing({ ...listing, fl: '2026-10-21' })
		);
		expect(errors).toEqual([]);
	});

	it('names held-back rows by code only, never by the raw value', () => {
		const out = clean([
			rawListing({ id: 3001, organization: 'RAW-BAD-NAME<' }),
			rawListing({ id: 3002, program: 'RAW-BAD-PROGRAM<' }),
			rawListing({ id: 3003, dateCreated: 'RAW-BAD-DATE' }),
			rawListing({ id: 3004, deliveryMethodId: 'RAW-BAD-DELIVERY' as unknown as number })
		]);
		expect(out.quarantine.map((q) => q.code)).toEqual([
			'E_Q_NAME',
			'E_Q_PROGRAM',
			'E_Q_DATE',
			'E_Q_DELIVERY'
		]);
		expect(JSON.stringify(out)).not.toContain('RAW-BAD');
	});
});
