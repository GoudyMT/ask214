import type { Branch, Delivery, Duration, Industry, Kind, Listing } from '../contract/listing';
import type { StateCode } from '../contract/places';
import { milesBetween, placement, type Placement, type Point } from './distance';

export type Filters = {
	industries?: Industry[];
	branches?: Branch[];
	durations?: Duration[];
	kinds?: Kind[];
	delivery?: Delivery[];
};

export type Radius = 25 | 50 | 100 | 'any';

export type Match = { listing: Listing; placement: Placement; miles?: number };

/** A chosen list constrains only when it holds something; the listing must state a value inside it. */
const anyOf = <T>(chosen: readonly T[] | undefined, has: readonly T[]) =>
	chosen === undefined || chosen.length === 0 || has.some((value) => chosen.includes(value));

const one = <T>(value: T | undefined): T[] => (value === undefined ? [] : [value]);

function passesFilters(listing: Listing, filters: Filters): boolean {
	return (
		anyOf(filters.industries, listing.ind) &&
		anyOf(filters.branches, listing.b) &&
		anyOf(filters.durations, one(listing.d)) &&
		anyOf(filters.kinds, one(listing.k)) &&
		anyOf(filters.delivery, [listing.m])
	);
}

/** Newest first: first seen, then created, both latest first; the lowest id last settles any remaining tie. */
const newestFirst = (a: Listing, b: Listing) =>
	b.fl.localeCompare(a.fl) || b.dc.localeCompare(a.dc) || a.i - b.i;

/** Where a placement sits in the list when a place is set. */
const TIER: Record<Placement['kind'], number> = {
	point: 0,
	multi: 1,
	state: 1,
	remote: 2,
	unlisted: 3
};

/**
 * The listings that pass the filters and the radius, in list order. With a place set: nearest first, then the
 * many-state and state-only programs, then remote, then those with no place. Without one: newest first, those
 * with no place last. Only filters and a place are inputs, so nothing about the person can reorder the list.
 */
export function matchListings(
	listings: readonly Listing[],
	query: { filters: Filters; point: Point | null; radius?: Radius }
): Match[] {
	const { filters, point, radius } = query;
	const rows: Match[] = [];
	for (const listing of listings) {
		if (!passesFilters(listing, filters)) continue;
		const where = placement(listing);
		if (point === null || where.kind !== 'point') {
			rows.push({ listing, placement: where });
			continue;
		}
		const miles = milesBetween(point, where);
		if (typeof radius === 'number' && miles > radius) continue;
		rows.push({ listing, placement: where, miles });
	}
	rows.sort((a, b) => {
		if (point !== null) {
			const tier = TIER[a.placement.kind] - TIER[b.placement.kind];
			if (tier !== 0) return tier;
			if (a.miles !== undefined && b.miles !== undefined && a.miles !== b.miles)
				return a.miles - b.miles;
		} else if (a.placement.kind === 'unlisted' || b.placement.kind === 'unlisted') {
			const last =
				Number(a.placement.kind === 'unlisted') - Number(b.placement.kind === 'unlisted');
			if (last !== 0) return last;
		}
		return newestFirst(a.listing, b.listing);
	});
	return rows;
}

/** Listings whose own state is `state` or whose named states include it. */
export function countInState(listings: readonly Listing[], state: StateCode): number {
	return listings.filter((listing) => listing.s === state || listing.ls?.includes(state) === true)
		.length;
}
