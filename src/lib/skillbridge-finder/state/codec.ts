import {
	BRANCHES,
	CAPS,
	DELIVERY,
	DURATIONS,
	INDUSTRIES,
	KINDS,
	type Listing
} from '../contract/listing';
import { STATE_CODES, isIsoDate } from '../contract/places';
import { isSafeText, validateListing } from '../contract/validate';
import { MAX_COMPARE, MAX_SAVED, type FinderRecord } from './types';

const SCHEMA_VERSION = 1;
const ZIP_RE = /^\d{5}$/;

const STATE_SET: ReadonlySet<unknown> = new Set(STATE_CODES);
const RADII: ReadonlySet<unknown> = new Set([25, 50, 100, 'any']);

/**
 * Every refusal is one of these static codes, so a stored record that fails to read says which part it could not trust
 * without echoing a value from it.
 */
export class FinderSchemaError extends Error {
	constructor(code: string) {
		super(code);
	}
}

const isObject = (x: unknown): x is Record<string, unknown> =>
	typeof x === 'object' && x !== null && !Array.isArray(x);
const isPositiveInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

function checkPlace(place: unknown): void {
	if (!isObject(place)) throw new FinderSchemaError('E_FINDER_BAD_SETUP');
	if (place.kind === 'zip') {
		if (typeof place.zip !== 'string' || !ZIP_RE.test(place.zip)) {
			throw new FinderSchemaError('E_FINDER_BAD_SETUP');
		}
	} else if (place.kind === 'base') {
		if (
			!isSafeText(place.name) ||
			place.name.length > CAPS.installation ||
			!STATE_SET.has(place.state)
		) {
			throw new FinderSchemaError('E_FINDER_BAD_SETUP');
		}
	} else if (place.kind === 'state') {
		if (!STATE_SET.has(place.state)) throw new FinderSchemaError('E_FINDER_BAD_SETUP');
	} else {
		throw new FinderSchemaError('E_FINDER_BAD_SETUP');
	}
}

function checkSetup(setup: unknown): void {
	if (!isObject(setup)) throw new FinderSchemaError('E_FINDER_BAD_SETUP');
	if (setup.place !== undefined) checkPlace(setup.place);
	if (setup.radius !== undefined && !RADII.has(setup.radius)) {
		throw new FinderSchemaError('E_FINDER_BAD_SETUP');
	}
	for (const flag of [setup.territories, setup.overseas]) {
		if (flag !== undefined && typeof flag !== 'boolean') {
			throw new FinderSchemaError('E_FINDER_BAD_SETUP');
		}
	}
}

const FILTER_LISTS: Record<string, ReadonlySet<unknown>> = {
	industries: new Set(INDUSTRIES),
	branches: new Set(BRANCHES),
	durations: new Set(DURATIONS),
	kinds: new Set(KINDS),
	delivery: new Set(Object.values(DELIVERY))
};

function checkFilters(filters: unknown): void {
	if (!isObject(filters)) throw new FinderSchemaError('E_FINDER_BAD_FILTERS');
	for (const [key, allowed] of Object.entries(FILTER_LISTS)) {
		const list = filters[key];
		if (list === undefined) continue;
		if (
			!Array.isArray(list) ||
			new Set(list).size !== list.length ||
			!list.every((v) => allowed.has(v))
		) {
			throw new FinderSchemaError('E_FINDER_BAD_FILTERS');
		}
	}
}

function checkSaved(list: unknown): void {
	if (!Array.isArray(list) || list.length > MAX_SAVED)
		throw new FinderSchemaError('E_FINDER_BAD_SAVED');
	const ids = new Set<unknown>();
	for (const item of list as unknown[]) {
		if (
			!isObject(item) ||
			!isPositiveInt(item.id) ||
			ids.has(item.id) ||
			!isIsoDate(item.savedOn)
		) {
			throw new FinderSchemaError('E_FINDER_BAD_SAVED');
		}
		ids.add(item.id);
		// The listing is kept whole, so it must pass the same contract the weekly files do, and be the one it names.
		if (validateListing(item.facts).length > 0 || (item.facts as Listing).i !== item.id) {
			throw new FinderSchemaError('E_FINDER_BAD_SAVED');
		}
	}
}

function checkCompare(list: unknown): void {
	if (
		!Array.isArray(list) ||
		list.length > MAX_COMPARE ||
		new Set(list).size !== list.length ||
		!list.every(isPositiveInt)
	) {
		throw new FinderSchemaError('E_FINDER_BAD_COMPARE');
	}
}

/** Throws a static code for the first part of a record that could not be trusted. Unknown keys are left alone. */
function checkRecord(record: Record<string, unknown>): void {
	if (record.schemaVersion !== SCHEMA_VERSION) throw new FinderSchemaError('E_FINDER_SCHEMA');
	if (record.finderSetup !== undefined) checkSetup(record.finderSetup);
	if (record.finderFilters !== undefined) checkFilters(record.finderFilters);
	checkSaved(record.finderSaved);
	checkCompare(record.finderCompare);
}

/**
 * Encoding holds the line decoding does: a record that was written but cannot be read back would lock the person out
 * of their own saves, so a change that would produce one is refused before anything is stored.
 */
export function encodeFinderRecord(record: FinderRecord): Uint8Array {
	checkRecord(record as unknown as Record<string, unknown>);
	return new TextEncoder().encode(JSON.stringify(record));
}

export function decodeFinderRecord(bytes: Uint8Array): FinderRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new FinderSchemaError('E_FINDER_SCHEMA');
	}
	if (!isObject(parsed)) throw new FinderSchemaError('E_FINDER_SCHEMA');
	checkRecord(parsed);
	// A key a newer release added is kept, so an older tab's save does not drop it.
	return { ...parsed } as FinderRecord;
}
