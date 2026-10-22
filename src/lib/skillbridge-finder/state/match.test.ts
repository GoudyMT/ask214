import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Listing } from '../contract/listing';
import { CLEAN_CASES, cleanListing } from '../fixtures/clean';
import { milesBetween } from './distance';
import { countInState, matchListings } from './match';

const ORIGIN = { la: 0, lo: 0 };
/** The latitude that is this many miles due north of the origin. */
const latFor = (miles: number) => ((miles / 3958.8) * 180) / Math.PI;

/** A one-state listing with a point `miles` north of the origin. */
const near = (i: number, miles: number, extra: Partial<Listing> = {}) =>
	cleanListing({ i, ls: ['MD'], s: 'MD', la: latFor(miles), lo: 0, ...extra });
/** A listing placed by its state alone. */
const inState = (i: number, extra: Partial<Listing> = {}) =>
	({ ...CLEAN_CASES.locationUnknown, i, s: 'TX', ...extra }) satisfies Listing;
const unlisted = (i: number, extra: Partial<Listing> = {}) =>
	({ ...CLEAN_CASES.locationUnknown, i, ...extra }) satisfies Listing;
const remote = (i: number, extra: Partial<Listing> = {}) =>
	({ ...CLEAN_CASES.remote, i, ...extra }) satisfies Listing;

const ids = (listings: readonly Listing[], point = ORIGIN, radius?: 25 | 50 | 100 | 'any') =>
	matchListings(listings, { filters: {}, point, radius: radius ?? 'any' }).map((m) => m.listing.i);

describe('matchListings filters', () => {
	const army = near(1, 5, { b: ['Army'], ind: ['Legal'], d: '1-30', k: 'internship', m: 1 });
	const navy = near(2, 5, { b: ['Navy'], ind: ['Production'], d: '31-60', k: 'fellowship', m: 3 });
	const both = near(3, 5, { b: ['Army', 'Navy'], ind: ['Legal', 'Production'], d: '61-90' });
	const all = [army, navy, both];
	const run = (filters: Parameters<typeof matchListings>[1]['filters']) =>
		matchListings(all, { filters, point: null })
			.map((m) => m.listing.i)
			.sort();

	// A veteran ticking Army and Navy wants either; an AND within one list would show them nothing.
	it('keeps a listing that matches any chosen value of one list', () => {
		expect(run({ branches: ['Army', 'Navy'] })).toEqual([1, 2, 3]);
		expect(run({ branches: ['Navy'] })).toEqual([2, 3]);
		expect(run({ industries: ['Legal'] })).toEqual([1, 3]);
		expect(run({ durations: ['1-30', '31-60'] })).toEqual([1, 2]);
		expect(run({ kinds: ['fellowship'] })).toEqual([2]);
		expect(run({ delivery: [3] })).toEqual([2]);
	});

	it('needs every list to match', () => {
		expect(run({ branches: ['Navy'], industries: ['Legal'] })).toEqual([3]);
		expect(run({ branches: ['Army'], durations: ['31-60'] })).toEqual([]);
	});

	it('treats a missing or empty list as no constraint', () => {
		expect(run({})).toEqual([1, 2, 3]);
		expect(run({ branches: [], industries: [], durations: [], kinds: [], delivery: [] })).toEqual([
			1, 2, 3
		]);
	});

	// A listing that does not say how long it lasts must not turn up under "31-60 days".
	it('never matches a chosen value on a field the listing does not state', () => {
		const silent = unlisted(9, { b: [] });
		const rows = matchListings([silent], { filters: { durations: ['1-30'] }, point: null });
		expect(rows).toEqual([]);
		expect(matchListings([silent], { filters: { kinds: ['internship'] }, point: null })).toEqual(
			[]
		);
		expect(matchListings([silent], { filters: { branches: ['Army'] }, point: null })).toEqual([]);
		expect(matchListings([silent], { filters: {}, point: null })).toHaveLength(1);
	});
});

describe('matchListings distance', () => {
	// The value of the boundary is checked against the function the list itself uses.
	it('reports miles only for a point listing, and only when a place is set', () => {
		const rows = matchListings([near(1, 10), remote(2), inState(3), unlisted(4)], {
			filters: {},
			point: ORIGIN
		});
		const byId = new Map(rows.map((m) => [m.listing.i, m]));
		expect(byId.get(1)?.miles).toBeCloseTo(10, 6);
		expect(byId.get(2)?.miles).toBeUndefined();
		expect(byId.get(3)?.miles).toBeUndefined();
		expect(byId.get(4)?.miles).toBeUndefined();
		const noPlace = matchListings([near(1, 10)], { filters: {}, point: null });
		expect(noPlace[0]?.miles).toBeUndefined();
		expect(noPlace[0]?.placement.kind).toBe('point');
	});

	// "Within 50 miles" must keep a program exactly 50 away and drop one 50.1 away. The point is found by stepping
	// the latitude one representable number at a time until the measured distance is exactly 50.
	it('keeps a listing exactly at the radius and drops one just past it', () => {
		// The next representable positive number up or down: its bit pattern moves by one.
		const step = (x: number, by: 1n | -1n) => {
			const view = new DataView(new ArrayBuffer(8));
			view.setFloat64(0, x);
			view.setBigUint64(0, view.getBigUint64(0) + by);
			return view.getFloat64(0);
		};
		let la = latFor(50);
		while (milesBetween(ORIGIN, { la, lo: 0 }) < 50) la = step(la, 1n);
		while (milesBetween(ORIGIN, { la, lo: 0 }) > 50) la = step(la, -1n);
		expect(milesBetween(ORIGIN, { la, lo: 0 })).toBe(50);
		expect(ids([cleanListing({ i: 1, ls: ['MD'], la, lo: 0 })], ORIGIN, 50)).toEqual([1]);
		expect(ids([near(2, 50.1)], ORIGIN, 50)).toEqual([]);
		expect(ids([near(3, 49.9)], ORIGIN, 50)).toEqual([3]);
		expect(ids([near(4, 30)], ORIGIN, 25)).toEqual([]);
		expect(ids([near(5, 80)], ORIGIN, 100)).toEqual([5]);
	});

	// Remote, many-state, state-only and unlisted programs have no honest distance, so a radius cannot rule them out.
	it('never drops a program that has no distance, at any radius', () => {
		const rows = [near(1, 500), remote(2), CLEAN_CASES.multiState, inState(4), unlisted(5)];
		expect(ids(rows, ORIGIN, 25).sort()).toEqual([2, 4, 5, 1013].sort());
	});

	it('drops nothing for any distance or when no radius is given', () => {
		const rows = [near(1, 500), near(2, 5)];
		expect(ids(rows, ORIGIN, 'any')).toEqual([2, 1]);
		expect(matchListings(rows, { filters: {}, point: ORIGIN }).map((m) => m.listing.i)).toEqual([
			2, 1
		]);
	});

	it('ignores the radius when no place is set', () => {
		const rows = matchListings([near(1, 500)], { filters: {}, point: null, radius: 25 });
		expect(rows).toHaveLength(1);
	});
});

describe('matchListings order', () => {
	it('puts nearest first when a place is set, then many-state and state-only, then remote, then unlisted', () => {
		const rows = [
			unlisted(6),
			remote(5),
			inState(4),
			near(2, 30),
			CLEAN_CASES.multiState,
			near(1, 10)
		];
		expect(ids(rows)).toEqual([1, 2, 1013, 4, 5, 6]);
	});

	it('breaks a tie in distance with the newest rule', () => {
		const older = near(1, 20, { fl: '2026-10-14' });
		const newer = near(2, 20, { fl: '2026-10-21' });
		expect(ids([older, newer])).toEqual([2, 1]);
	});

	// Many-state and state-only programs share one tier, ordered by newest, so neither always outranks the other.
	it('orders the many-state and state-only tier by the newest rule', () => {
		const stateOld = inState(1, { fl: '2026-10-07' });
		const multiNew = { ...CLEAN_CASES.multiState, fl: '2026-10-21' };
		expect(ids([stateOld, multiNew])).toEqual([1013, 1]);
	});

	it('puts newest first with no place: first seen, then created, then lowest id, unlisted last', () => {
		const rows = [
			unlisted(10, { fl: '2026-10-28', dc: '2026-01-01' }),
			near(1, 5, { fl: '2026-10-14', dc: '2026-10-01' }),
			remote(2, { fl: '2026-10-21', dc: '2026-09-01' }),
			near(3, 5, { fl: '2026-10-21', dc: '2026-09-15' }),
			near(5, 5, { fl: '2026-10-21', dc: '2026-09-15' }),
			near(4, 5, { fl: '2026-10-21', dc: '2026-09-15' })
		];
		const out = matchListings(rows, { filters: {}, point: null }).map((m) => m.listing.i);
		expect(out).toEqual([3, 4, 5, 2, 1, 10]);
	});

	it('gives the same order whatever order the listings arrive in', () => {
		const rows = [near(1, 5), near(2, 5), near(3, 5, { fl: '2026-10-14' })];
		const forward = ids(rows);
		const backward = ids([...rows].reverse());
		expect(backward).toEqual(forward);
	});
});

describe('countInState', () => {
	it('counts the listings whose own state or named states include the state', () => {
		const rows = [
			cleanListing({ i: 1, s: 'MD', ls: ['MD'] }),
			cleanListing({ i: 2, s: 'MD', ls: ['MD', 'VA'] }),
			cleanListing({ i: 3, s: 'VA', ls: ['VA', 'MD'] }),
			inState(4, { s: 'MD' }),
			cleanListing({ i: 5, s: 'TX', ls: ['TX'] }),
			remote(6)
		];
		expect(countInState(rows, 'MD')).toBe(4);
		expect(countInState(rows, 'VA')).toBe(2);
		expect(countInState(rows, 'AK')).toBe(0);
	});
});

// Nothing in the list is sorted, highlighted or filtered by what the person's profile holds, so the matcher has no
// such input. The scan looks for those words as identifiers in the code (comments removed).
function profileWords(source: string): string[] {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	return code.match(/\b(?:rate|rank|profile)\w*|\b\w*(?:Rate|Rank|Profile)\w*/g) ?? [];
}

describe('what the matcher may read', () => {
	it('finds a planted profile input in the scan', () => {
		expect(profileWords('const rank = person.rank;\nconst userProfile = 1;')).toEqual([
			'rank',
			'rank',
			'userProfile'
		]);
		expect(profileWords('// a rank in a comment\nconst a = 1;')).toEqual([]);
	});

	it('has no rate, rank or profile in match.ts', () => {
		const source = readFileSync(new URL('./match.ts', import.meta.url), 'utf-8');
		expect(profileWords(source)).toEqual([]);
	});
});
