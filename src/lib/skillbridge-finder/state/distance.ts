import type { Listing } from '../contract/listing';
import type { StateCode } from '../contract/places';
import type { BasesTable, ZipsTable } from '../contract/tables';

export type Point = { la: number; lo: number };

/** A place a person can set: a ZIP, an installation (name and state) or a whole state. */
export type Place =
	| { kind: 'zip'; zip: string }
	| { kind: 'base'; name: string; state: StateCode }
	| { kind: 'state'; state: StateCode };

export type Placement =
	| { kind: 'remote' }
	| { kind: 'multi'; states: number }
	| { kind: 'point'; la: number; lo: number }
	| { kind: 'state'; state: StateCode }
	| { kind: 'unlisted' };

const EARTH_RADIUS_MILES = 3958.8;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance in miles. */
export function milesBetween(a: Point, b: Point): number {
	const dLa = radians(b.la - a.la);
	const dLo = radians(b.lo - a.lo);
	const h =
		Math.sin(dLa / 2) ** 2 +
		Math.cos(radians(a.la)) * Math.cos(radians(b.la)) * Math.sin(dLo / 2) ** 2;
	// Rounding can push h a hair past 1 for opposite points; asin of that would be NaN.
	return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * The point a place stands for, or null when it has none: a state alone has no centre, and a table or row that
 * is missing gives nothing to measure from.
 */
export function placePoint(place: Place, zips?: ZipsTable, bases?: BasesTable): Point | null {
	if (place.kind === 'zip') {
		const row = zips?.rows.find((r) => r[0] === place.zip);
		return row === undefined ? null : { la: row[1], lo: row[2] };
	}
	if (place.kind === 'base') {
		const row = bases?.rows.find((r) => r[0] === place.name && r[1] === place.state);
		return row === undefined ? null : { la: row[2], lo: row[3] };
	}
	return null;
}

/** How a listing is placed, which decides whether it can carry a distance. */
export function placement(listing: Listing): Placement {
	if (listing.m === 2) return { kind: 'remote' };
	const states = new Set(listing.ls).size;
	if (states >= 2) return { kind: 'multi', states };
	if (listing.la !== undefined && listing.lo !== undefined)
		return { kind: 'point', la: listing.la, lo: listing.lo };
	if (listing.s !== undefined) return { kind: 'state', state: listing.s };
	return { kind: 'unlisted' };
}
