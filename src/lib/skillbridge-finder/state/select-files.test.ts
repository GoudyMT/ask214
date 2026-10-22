import { describe, it, expect } from 'vitest';
import { DIVISIONS } from '../contract/places';
import { selectRegionFiles, type StateExtents } from './select-files';

// Made-up boxes [south, west, north, east], not real borders: MD (south-atlantic) and PA (middle-atlantic) meet
// along latitude 39.7; AK crosses the 180th meridian; PR is a territory; MT sits far north for the longitude test.
const EXTENTS: StateExtents = {
	MD: [38, -80, 39.7, -75],
	PA: [39.7, -80, 42, -75],
	AK: [51, 172, 71, -130],
	PR: [17.8, -67.3, 18.6, -65.2],
	MT: [58, -110, 62, -100]
};

const MILES_PER_DEGREE = 69;
// A point in MD this many miles south of the MD/PA line.
const milesSouthOfLine = (miles: number) => 39.7 - miles / MILES_PER_DEGREE;

const FIXED = ['multi-state', 'remote'];

describe('selectRegionFiles', () => {
	it('with no place and no search, fetches only the files every search needs', () => {
		expect(selectRegionFiles({}, EXTENTS)).toEqual(FIXED);
		// A radius means nothing without a place, and must not pull in a division.
		expect(selectRegionFiles({ radiusMiles: 50 }, EXTENTS)).toEqual(FIXED);
	});

	it('adds territories and overseas only when asked', () => {
		expect(selectRegionFiles({ territories: true }, EXTENTS)).toEqual([...FIXED, 'territories']);
		expect(selectRegionFiles({ overseas: true }, EXTENTS)).toEqual([...FIXED, 'overseas']);
		expect(selectRegionFiles({ territories: false, overseas: false }, EXTENTS)).toEqual(FIXED);
	});

	it('searching with no place fetches every division and the unplaced file', () => {
		expect(selectRegionFiles({ searchAll: true }, EXTENTS)).toEqual([
			...DIVISIONS,
			...FIXED,
			'unknown'
		]);
	});

	it('a chosen state fetches its division and the unplaced file, nothing else', () => {
		expect(selectRegionFiles({ place: { kind: 'state', state: 'MD' } }, EXTENTS)).toEqual([
			'south-atlantic',
			...FIXED,
			'unknown'
		]);
	});

	it('a territory has no division: it fetches the territories file instead', () => {
		expect(selectRegionFiles({ place: { kind: 'state', state: 'PR' } }, EXTENTS)).toEqual([
			...FIXED,
			'territories',
			'unknown'
		]);
	});

	describe('a point', () => {
		const point = { kind: 'point', la: milesSouthOfLine(30), lo: -77.5 } as const;

		it('with no radius is matched by the box alone', () => {
			expect(selectRegionFiles({ place: point }, EXTENTS)).toEqual([
				'south-atlantic',
				...FIXED,
				'unknown'
			]);
		});

		// 30 miles from the line: a 25 mile search stays in its division, a 50 mile search reaches over the line.
		it('adds the division across a border only when the radius reaches it', () => {
			expect(selectRegionFiles({ place: point, radiusMiles: 25 }, EXTENTS)).toEqual([
				'south-atlantic',
				...FIXED,
				'unknown'
			]);
			expect(selectRegionFiles({ place: point, radiusMiles: 50 }, EXTENTS)).toEqual([
				'middle-atlantic',
				'south-atlantic',
				...FIXED,
				'unknown'
			]);
		});

		// A degree of longitude is shorter the further north you stand, so the same miles reach further east.
		it('grows the box in longitude by the miles at the point latitude', () => {
			const place = { kind: 'point', la: 60, lo: -99, state: 'ND' } as const;
			expect(selectRegionFiles({ place, radiusMiles: 25 }, EXTENTS)).toEqual([
				'west-north-central',
				...FIXED,
				'unknown'
			]);
			expect(selectRegionFiles({ place, radiusMiles: 50 }, EXTENTS)).toEqual([
				'west-north-central',
				'mountain',
				...FIXED,
				'unknown'
			]);
		});

		it("always includes the place's own state even when no box holds the point", () => {
			const place = { kind: 'point', la: 30, lo: -60, state: 'MD' } as const;
			expect(selectRegionFiles({ place }, EXTENTS)).toEqual([
				'south-atlantic',
				...FIXED,
				'unknown'
			]);
		});

		it("with the radius 'any' fetches every division, and not the territories", () => {
			expect(selectRegionFiles({ place: point, radiusMiles: 'any' }, EXTENTS)).toEqual([
				...DIVISIONS,
				...FIXED,
				'unknown'
			]);
		});

		// When the place cannot be found, covering every division is safe; missing the right one is not.
		it('inside no box and with no state fetches every division', () => {
			const lost = { kind: 'point', la: 30, lo: -60 } as const;
			expect(selectRegionFiles({ place: lost }, EXTENTS)).toEqual([
				...DIVISIONS,
				...FIXED,
				'unknown'
			]);
		});

		it('inside a territory box fetches the territories file, not a division', () => {
			const place = { kind: 'point', la: 18.2, lo: -66.4 } as const;
			expect(selectRegionFiles({ place }, EXTENTS)).toEqual([...FIXED, 'territories', 'unknown']);
		});

		// Alaska's box wraps the date line: west 172, east -130 means "from 172 east to 130 west".
		it('finds a point on either side of the 180th meridian in a box that crosses it', () => {
			for (const lo of [175, -175, 180, -135]) {
				const place = { kind: 'point', la: 60, lo, state: 'TX' } as const;
				expect(selectRegionFiles({ place }, EXTENTS)).toEqual([
					'west-south-central',
					'pacific',
					...FIXED,
					'unknown'
				]);
			}
		});

		it('does not put a point outside a box that crosses the 180th meridian inside it', () => {
			for (const lo of [0, -120, 100, 170]) {
				const place = { kind: 'point', la: 60, lo, state: 'TX' } as const;
				expect(selectRegionFiles({ place }, EXTENTS)).toEqual([
					'west-south-central',
					...FIXED,
					'unknown'
				]);
			}
		});

		// A bad coordinate must fall back to the place's state or to everything, never match a box by accident.
		it.each([
			['NaN latitude', { la: NaN, lo: -77.5 }],
			['infinite latitude', { la: Infinity, lo: -77.5 }],
			['NaN longitude', { la: 60, lo: NaN }],
			['infinite longitude on the date-line box', { la: 60, lo: Infinity }],
			['negative infinite longitude on the date-line box', { la: 60, lo: -Infinity }]
		])('treats %s as a point inside no box', (_name, coords) => {
			const withState = { kind: 'point', ...coords, state: 'TX' } as const;
			expect(selectRegionFiles({ place: withState, radiusMiles: 100 }, EXTENTS)).toEqual([
				'west-south-central',
				...FIXED,
				'unknown'
			]);
			const without = { kind: 'point', ...coords } as const;
			expect(selectRegionFiles({ place: without }, EXTENTS)).toEqual([
				...DIVISIONS,
				...FIXED,
				'unknown'
			]);
		});
	});
});
