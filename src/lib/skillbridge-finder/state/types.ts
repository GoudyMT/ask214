import type { Branch, Delivery, Duration, Industry, Kind, Listing } from '../contract/listing';
import type { StateCode } from '../contract/places';

/**
 * What the finder keeps on the device, encrypted: where a person is looking, the programs they saved, the ones
 * they are comparing and their filters. The four personal keys of the record carry a `finder` prefix on purpose:
 * the off-device guard (src/lib/ci/pii-policy.ts) matches names without a dot, and an ordinary word such as
 * "saved" or "compare" would trip it in unrelated code.
 */

export type FinderPlace = { kind: 'zip'; zip: string } | { kind: 'state'; state: StateCode };

export type FinderRadius = 25 | 50 | 100 | 'any';

export type FinderSetup = {
	place?: FinderPlace;
	radius?: FinderRadius;
	territories?: boolean;
	overseas?: boolean;
};

export type FinderFilters = {
	industries?: Industry[];
	branches?: Branch[];
	durations?: Duration[];
	kinds?: Kind[];
	delivery?: Delivery[];
};

/** A saved program is kept whole: the listing may leave the weekly files, and the person still has it. */
export type FinderSavedItem = { id: number; savedOn: string; facts: Listing };

export type FinderRecord = {
	schemaVersion: 1;
	finderSetup?: FinderSetup;
	finderFilters?: FinderFilters;
	finderSaved: FinderSavedItem[];
	finderCompare: number[];
};

export const MAX_SAVED = 200;
export const MAX_COMPARE = 3;
