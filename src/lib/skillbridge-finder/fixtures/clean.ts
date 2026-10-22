/**
 * Synthetic published listings, one for each way a listing can be placed and shown: in person, hybrid, remote,
 * many states, a territory, no usable place, a form link instead of an email, open to all occupations. Made-up
 * values; emails at example.com.
 */

import type { Listing } from '../contract/listing';

export function cleanListing(overrides: Partial<Listing> = {}): Listing {
	return {
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
		fl: '2026-10-21',
		e: 'skillbridge@example.com',
		w: 'https://example.com/',
		...overrides
	};
}

export const CLEAN_CASES = {
	inPerson: cleanListing(),
	hybrid: cleanListing({ i: 1039, m: 3, dib: true }),
	remote: {
		i: 1005,
		o: 302,
		n: 'Example Remote Academy',
		p: 'Software Support Fellowship',
		k: 'fellowship',
		m: 2,
		b: [],
		ind: ['Computer and Mathematical'],
		dib: false,
		dc: '2026-09-01',
		fl: '2026-10-14',
		u: 'https://forms.example.com/apply'
	},
	multiState: cleanListing({
		i: 1013,
		o: 303,
		n: 'Example National Logistics',
		ls: ['AK', 'AL', 'AZ', 'CA', 'CO', 'FL', 'GA', 'HI', 'MD', 'NC', 'TX', 'VA', 'WA'],
		oc: 'all',
		li: 'https://www.linkedin.com/company/example-national-logistics'
	}),
	territory: cleanListing({
		i: 1038,
		o: 304,
		n: 'Example Island Health',
		c: 'San Juan',
		s: 'PR',
		ls: ['PR'],
		z: '00901',
		la: 18.46,
		lo: -66.1,
		ind: ['Healthcare Support']
	}),
	// No usable place: the coordinates were outside the state and no ZIP centroid applied.
	locationUnknown: {
		i: 1003,
		o: 305,
		n: 'Example Field Works',
		p: 'Construction Apprenticeship',
		k: 'apprenticeship',
		m: 1,
		b: ['Marine Corps'],
		ind: ['Construction and Extraction'],
		dib: false,
		dc: '2026-06-02',
		fl: '2026-10-21',
		e: 'apprentice@example.com'
	}
} satisfies Record<string, Listing>;
