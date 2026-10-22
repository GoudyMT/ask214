import { describe, it, expect } from 'vitest';
import { encodeFinderRecord, decodeFinderRecord, FinderSchemaError } from './codec';
import { MAX_COMPARE, MAX_SAVED, type FinderRecord, type FinderSavedItem } from './types';
import type { Listing } from '../contract/listing';

function listing(i: number, overrides: Partial<Listing> = {}): Listing {
	return {
		i,
		o: 297,
		n: 'Example Training Co',
		p: 'Field Technician Internship',
		k: 'internship',
		c: 'Columbia',
		s: 'MD',
		z: '21046',
		d: '91-120',
		m: 1,
		b: ['Navy', 'Army'],
		ind: ['Installation, Maintenance, and Repair'],
		dib: true,
		dc: '2026-07-24',
		fl: '2026-10-21',
		...overrides
	};
}

const saved = (id: number, overrides: Partial<FinderSavedItem> = {}): FinderSavedItem => ({
	id,
	savedOn: '2026-10-21',
	facts: listing(id),
	...overrides
});

const full: FinderRecord = {
	schemaVersion: 1,
	finderSetup: {
		place: { kind: 'zip', zip: '21046' },
		radius: 50,
		territories: false,
		overseas: true
	},
	finderFilters: {
		industries: ['Legal', 'Healthcare Support'],
		branches: ['Navy'],
		durations: ['91-120'],
		kinds: ['internship'],
		delivery: [1, 3]
	},
	finderSaved: [saved(386), saved(412)],
	finderCompare: [386, 412]
};

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
/** The full record with one top-level key replaced, as the bytes a stored record would hold. */
const withKey = (key: string, value: unknown) => bytesOf({ ...full, [key]: value });

function expectRefused(bytes: Uint8Array, code: string) {
	let caught: unknown;
	try {
		decodeFinderRecord(bytes);
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(FinderSchemaError);
	expect((caught as FinderSchemaError).message).toBe(code);
}

describe('finder record codec', () => {
	it('round-trips a full record, and a bare one', () => {
		expect(decodeFinderRecord(encodeFinderRecord(full))).toEqual(full);
		const bare: FinderRecord = { schemaVersion: 1, finderSaved: [], finderCompare: [] };
		expect(decodeFinderRecord(encodeFinderRecord(bare))).toEqual(bare);
	});

	// Same policy as the calendar record: a key a newer release added survives a re-save by this one.
	it('keeps a key it does not know', () => {
		const decoded = decodeFinderRecord(withKey('futureKey', { a: 1 }));
		expect((decoded as Record<string, unknown>).futureKey).toEqual({ a: 1 });
	});

	// A record that is written but cannot be read back would lock the person out of their own saves, so the write side
	// holds the same line as the read side.
	it('refuses to encode a record it would refuse to read', () => {
		const badZip: FinderRecord = { ...full, finderSetup: { place: { kind: 'zip', zip: '2104' } } };
		expect(() => encodeFinderRecord(badZip)).toThrow('E_FINDER_BAD_SETUP');
		const badSaved: FinderRecord = { ...full, finderSaved: [saved(386, { facts: listing(387) })] };
		expect(() => encodeFinderRecord(badSaved)).toThrow('E_FINDER_BAD_SAVED');
	});

	describe('refuses what it cannot trust, with a static code', () => {
		it('bytes that are not a record, and any other schemaVersion', () => {
			expectRefused(new Uint8Array([0xff, 0xfe]), 'E_FINDER_SCHEMA');
			expectRefused(new TextEncoder().encode('[]'), 'E_FINDER_SCHEMA');
			expectRefused(withKey('schemaVersion', 2), 'E_FINDER_SCHEMA');
		});

		const badSetup: [string, unknown][] = [
			['a ZIP of four digits', { place: { kind: 'zip', zip: '2104' } }],
			['a ZIP with text after the digits', { place: { kind: 'zip', zip: '21046\n' } }],
			['a state that is not a state code', { place: { kind: 'state', state: 'ZZ' } }],
			['a place kind it does not know', { place: { kind: 'city', name: 'Columbia' } }],
			[
				'an installation, which the finder no longer takes as a place',
				{ place: { kind: 'base', name: 'Fort Meade', state: 'MD' } }
			],
			['a radius off the four values', { radius: 75 }],
			['a radius given as text', { radius: '50' }],
			['an overseas flag that is not a boolean', { overseas: 'yes' }]
		];
		it.each(badSetup)('setup with %s', (_name, setup) => {
			expectRefused(withKey('finderSetup', setup), 'E_FINDER_BAD_SETUP');
		});

		const badFilters: [string, unknown][] = [
			['an industry off the list', { industries: ['Legal', 'Pirate'] }],
			['a branch off the list', { branches: ['Navy', 'Air Cadets'] }],
			['a duration off the list', { durations: ['1-31'] }],
			['a kind off the list', { kinds: ['internship', 'volunteering'] }],
			['a delivery id off the list', { delivery: [1, 4] }],
			['a delivery id given as text', { delivery: ['1'] }],
			['a value repeated in a list', { branches: ['Navy', 'Navy'] }],
			['a list that is not a list', { kinds: 'internship' }]
		];
		it.each(badFilters)('filters with %s', (_name, filters) => {
			expectRefused(withKey('finderFilters', filters), 'E_FINDER_BAD_FILTERS');
		});

		const dupSaved = [saved(386), saved(386, { savedOn: '2026-10-22' })];
		const manySaved = Array.from({ length: MAX_SAVED + 1 }, (_, n) => saved(n + 1));
		const badSaved: [string, unknown][] = [
			['more than the cap', manySaved],
			['the same id twice', dupSaved],
			// One bad date and one bad listing: the rules for each are the contract's, tested there; this proves the call is made.
			['a date that is not a day', [saved(386, { savedOn: '2026-02-30' })]],
			['facts the contract refuses', [saved(386, { facts: listing(386, { z: '2104' }) })]],
			['facts of another listing than its id', [saved(386, { facts: listing(387) })]],
			['an id that is not a positive integer', [saved(0, { facts: listing(0) })]],
			['not a list', { 386: saved(386) }]
		];
		it.each(badSaved)('saved with %s', (_name, list) => {
			expectRefused(withKey('finderSaved', list), 'E_FINDER_BAD_SAVED');
		});

		it('saved at exactly the cap is kept', () => {
			const atCap = Array.from({ length: MAX_SAVED }, (_, n) => saved(n + 1));
			const decoded = decodeFinderRecord(withKey('finderSaved', atCap));
			expect(decoded.finderSaved).toHaveLength(MAX_SAVED);
		});

		const badCompare: [string, unknown][] = [
			['more than the cap', Array.from({ length: MAX_COMPARE + 1 }, (_, n) => n + 1)],
			['the same id twice', [386, 386]],
			['an id of zero', [0]],
			['a fractional id', [1.5]],
			['an id past the safe integers', [Number.MAX_SAFE_INTEGER + 2]],
			['an id given as text', ['386']],
			['not a list', 386]
		];
		it.each(badCompare)('compare with %s', (_name, ids) => {
			expectRefused(withKey('finderCompare', ids), 'E_FINDER_BAD_COMPARE');
		});

		it('compare at exactly the cap is kept', () => {
			const decoded = decodeFinderRecord(withKey('finderCompare', [1, 2, MAX_COMPARE]));
			expect(decoded.finderCompare).toEqual([1, 2, MAX_COMPARE]);
		});
	});
});
