import { describe, it, expect } from 'vitest';
import type { ZipsTable } from '../contract/tables';
import { CLEAN_CASES, cleanListing } from '../fixtures/clean';
import { milesBetween, placePoint, placement } from './distance';

describe('milesBetween', () => {
	// A person comparing two programs reads this number as a drive; a wrong radius of the earth or a degrees/radians
	// slip would put every program in the wrong place in the list. New York to Los Angeles is about 2,445.5 miles.
	it('measures a known city pair to within a mile of the published great-circle distance', () => {
		const newYork = { la: 40.7128, lo: -74.006 };
		const losAngeles = { la: 34.0522, lo: -118.2437 };
		expect(Math.abs(milesBetween(newYork, losAngeles) - 2445.5)).toBeLessThan(1);
		expect(milesBetween(newYork, newYork)).toBe(0);
	});
});

describe('placePoint', () => {
	const zips: ZipsTable = {
		v: 1,
		rows: [
			['21046', 39.2, -76.86],
			['00901', 18.46, -66.1]
		]
	};
	it('gives a ZIP the point of its own row', () => {
		expect(placePoint({ kind: 'zip', zip: '21046' }, zips)).toEqual({
			la: 39.2,
			lo: -76.86
		});
	});

	// A state has no centre, so a state alone never gets a distance (it would be a guess presented as a measure).
	it('gives a whole state no point', () => {
		expect(placePoint({ kind: 'state', state: 'MD' }, zips)).toBeNull();
	});

	it('gives no point when the table or the row is missing', () => {
		expect(placePoint({ kind: 'zip', zip: '21046' })).toBeNull();
		expect(placePoint({ kind: 'zip', zip: '99999' }, zips)).toBeNull();
	});
});

describe('placement', () => {
	it('is a point for a one-state listing with both coordinates', () => {
		expect(placement(cleanListing({ ls: ['MD'] }))).toEqual({
			kind: 'point',
			la: 39.2,
			lo: -76.86
		});
	});

	// Remote work never has a distance, even if a stray point rides along.
	it('is remote for a remote listing, whatever else it carries', () => {
		expect(placement(CLEAN_CASES.remote)).toEqual({ kind: 'remote' });
		expect(placement(cleanListing({ m: 2 }))).toEqual({ kind: 'remote' });
	});

	// "Offered in 2 states" has no one place to measure from, even when the listing has a point.
	it('is multi for a listing that names two or more states, even with a point', () => {
		expect(placement(CLEAN_CASES.inPerson)).toEqual({ kind: 'multi', states: 2 });
		expect(placement(CLEAN_CASES.multiState)).toEqual({ kind: 'multi', states: 13 });
	});

	it('is the state when there is a state but no point, or only half a point', () => {
		expect(placement({ ...CLEAN_CASES.locationUnknown, s: 'TX' })).toEqual({
			kind: 'state',
			state: 'TX'
		});
		expect(placement({ ...CLEAN_CASES.locationUnknown, s: 'TX', la: 30.1 })).toEqual({
			kind: 'state',
			state: 'TX'
		});
	});

	it('is unlisted when nothing places it', () => {
		expect(placement(CLEAN_CASES.locationUnknown)).toEqual({ kind: 'unlisted' });
		expect(placement({ ...CLEAN_CASES.locationUnknown, la: 30.1 })).toEqual({ kind: 'unlisted' });
	});
});
