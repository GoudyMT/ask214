import { describe, it, expect } from 'vitest';
import {
	bucketOn,
	chipsOf,
	clearAllChips,
	countBy,
	placeChipLabel,
	removeChip,
	toggled,
	toggledBucket,
	widerRadius
} from './list-model';
import { cleanListing } from '../fixtures/clean';
import type { FinderFilters, FinderSetup } from '../state/types';

const SETUP: FinderSetup = {
	place: { kind: 'zip', zip: '21046' },
	radius: 100,
	territories: true,
	overseas: false
};
const FILTERS: FinderFilters = {
	delivery: [3, 1],
	industries: ['Legal'],
	branches: ['Navy'],
	durations: ['1-30', '31-60']
};

describe('chipsOf', () => {
	it('has one chip per choice, in the order of the page: place, format, field, branch, length', () => {
		expect(chipsOf(SETUP, FILTERS).map((c) => c.label)).toEqual([
			'Near 21046 - 100 mi',
			'In person',
			'Hybrid',
			'Legal',
			'Navy',
			'Up to 60 days'
		]);
	});

	it('words a state, a ZIP with no reach and a ZIP with any distance', () => {
		expect(placeChipLabel({ place: { kind: 'state', state: 'MD' } })).toBe('In Maryland');
		expect(placeChipLabel({ place: { kind: 'zip', zip: '21046' } })).toBe('Near 21046');
		expect(placeChipLabel({ place: { kind: 'zip', zip: '21046' }, radius: 'any' })).toBe(
			'Near 21046 - any distance'
		);
		expect(placeChipLabel({})).toBeNull();
	});

	it('has none for a person who chose nothing', () => {
		expect(chipsOf({ territories: false, overseas: false }, {})).toEqual([]);
	});

	// A saved program kind has no control in the sheet; its chip is the one way to take it off.
	it('has a chip for a kind kept in the record', () => {
		expect(chipsOf({}, { kinds: ['apprenticeship'] }).map((c) => c.label)).toEqual([
			'Apprenticeship'
		]);
	});
});

describe('removeChip', () => {
	it.each([
		[
			'delivery:3',
			{ delivery: [1], industries: ['Legal'], branches: ['Navy'], durations: ['1-30', '31-60'] }
		],
		['industry:Legal', { delivery: [3, 1], branches: ['Navy'], durations: ['1-30', '31-60'] }],
		['branch:Navy', { delivery: [3, 1], industries: ['Legal'], durations: ['1-30', '31-60'] }],
		['length:Up to 60 days', { delivery: [3, 1], industries: ['Legal'], branches: ['Navy'] }]
	])('takes away only %s', (id, expected) => {
		const result = removeChip(id, SETUP, FILTERS);
		expect(result.filters).toEqual(expected);
		expect(result.setup).toEqual(SETUP);
	});

	it('takes the place and its reach away but keeps the territory choices', () => {
		const result = removeChip('place', SETUP, FILTERS);
		expect(result.setup).toEqual({ territories: true, overseas: false });
		expect(result.filters).toEqual(FILTERS);
	});

	it('drops a filter that has nothing left, so the record holds no empty list', () => {
		expect(removeChip('industry:Legal', {}, { industries: ['Legal'] }).filters).toEqual({});
	});

	it('clears everything for Clear all', () => {
		expect(clearAllChips(SETUP)).toEqual({
			setup: { territories: true, overseas: false },
			filters: {}
		});
	});
});

describe('toggles', () => {
	it('switches a value on and off and drops an emptied list', () => {
		expect(toggled(undefined, 'a')).toEqual(['a']);
		expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
		expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
		expect(toggled(['a'], 'a')).toBeUndefined();
	});

	it('switches a length bucket as a whole, and counts a half-chosen one as not on', () => {
		const bucket = ['1-30', '31-60'] as const;
		expect(bucketOn(['1-30'], bucket)).toBe(false);
		expect(toggledBucket(['1-30'], bucket)).toEqual(['1-30', '31-60']);
		expect(toggledBucket(['1-30', '31-60', '180+'], bucket)).toEqual(['180+']);
		expect(toggledBucket(['1-30', '31-60'], bucket)).toBeUndefined();
	});
});

describe('widerRadius', () => {
	it('offers 100 miles from a smaller reach and nothing from 100, any or none', () => {
		expect([25, 50, 100, 'any', undefined].map((r) => widerRadius(r as never))).toEqual([
			100,
			100,
			null,
			null,
			null
		]);
	});
});

describe('countBy', () => {
	it('counts the rows that hold each value', () => {
		const rows = [
			{ listing: cleanListing({ i: 1, m: 1 }) },
			{ listing: cleanListing({ i: 2, m: 1 }) },
			{ listing: cleanListing({ i: 3, m: 2 }) }
		];
		const counts = countBy(rows, [1, 2, 3], (l, v) => l.m === v);
		expect([...counts]).toEqual([
			[1, 2],
			[2, 1],
			[3, 0]
		]);
	});
});
