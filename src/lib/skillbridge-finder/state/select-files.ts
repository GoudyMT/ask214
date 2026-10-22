/**
 * Which region files a person's place needs. This is the personal step: it reads the place, and hands the fetch
 * part nothing but file names, so a request never carries the place itself - only the coarse division files a
 * whole region of people would also download.
 */

import {
	DIVISIONS,
	DIVISION_OF_STATE,
	REGION_FILE_NAMES,
	TERRITORY_CODES,
	type RegionFileName,
	type StateCode
} from '../contract/places';

/** Degrees; `east < west` means the box crosses the 180th meridian. */
export type Extent = readonly [south: number, west: number, north: number, east: number];
export type StateExtents = Readonly<Partial<Record<StateCode, Extent>>>;
export type SelectInput = {
	place?:
		| { kind: 'state'; state: StateCode }
		| { kind: 'point'; la: number; lo: number; state?: StateCode };
	radiusMiles?: 25 | 50 | 100 | 'any';
	territories?: boolean;
	overseas?: boolean;
	/** The person searched with no place at all. */
	searchAll?: boolean;
};

const MILES_PER_DEGREE_OF_LATITUDE = 69;
// Near a pole a degree of longitude shrinks toward nothing; the floor keeps the growth finite.
const MIN_COS_LATITUDE = 0.01;

/**
 * Whether the point is in the box grown by `miles`. Written so a NaN or infinite coordinate fails every
 * comparison and lands in no box: a bad point must never select a division by accident.
 */
function inBox(la: number, lo: number, box: Extent, miles: number): boolean {
	const [south, west, north, east] = box;
	const growLa = miles / MILES_PER_DEGREE_OF_LATITUDE;
	const growLo =
		miles /
		(MILES_PER_DEGREE_OF_LATITUDE * Math.max(Math.cos((la * Math.PI) / 180), MIN_COS_LATITUDE));
	if (!(la >= south - growLa && la <= north + growLa)) return false;
	// A box that crosses the 180th meridian runs on past 180; the point is tried one turn either way so a
	// longitude written as 175 or as -185 lands in the same place.
	const farEast = east < west ? east + 360 : east;
	return [lo, lo + 360, lo - 360].some((x) => x >= west - growLo && x <= farEast + growLo);
}

export function selectRegionFiles(input: SelectInput, extents: StateExtents): RegionFileName[] {
	const chosen = new Set<RegionFileName>(['multi-state', 'remote']);
	if (input.territories) chosen.add('territories');
	if (input.overseas) chosen.add('overseas');

	const addState = (state: StateCode) => {
		const division = DIVISION_OF_STATE[state];
		if (division) chosen.add(division);
		else if (TERRITORY_CODES.includes(state)) chosen.add('territories');
	};
	const addEveryDivision = () => DIVISIONS.forEach((d) => chosen.add(d));

	const { place } = input;
	if (place === undefined) {
		if (input.searchAll) {
			addEveryDivision();
			chosen.add('unknown');
		}
	} else {
		chosen.add('unknown');
		if (place.kind === 'state') addState(place.state);
		else {
			if (place.state) addState(place.state);
			if (input.radiusMiles === 'any') addEveryDivision();
			else {
				const { la, lo } = place;
				const miles = input.radiusMiles ?? 0;
				const hits = (Object.entries(extents) as [StateCode, Extent][]).filter(([, box]) =>
					inBox(la, lo, box, miles)
				);
				for (const [state] of hits) addState(state);
				if (hits.length === 0 && place.state === undefined) addEveryDivision();
			}
		}
	}

	return REGION_FILE_NAMES.filter((name) => chosen.has(name));
}
