import { describe, it, expect } from 'vitest';
import { parsePlaceText, placeText, suggestPlaces } from './place-text';
import type { ZipsTable } from '../contract/tables';

const ZIPS: ZipsTable = {
	v: 1,
	rows: [
		['21044', 'MD', 39.21, -76.88],
		['21046', 'MD', 39.2, -76.86],
		['21001', 'MD', 39.5, -76.2],
		['77001', 'TX', 29.7, -95.3]
	]
};

describe('parsePlaceText', () => {
	it.each([
		['21046', { kind: 'zip', zip: '21046' }],
		['  21046 ', { kind: 'zip', zip: '21046' }],
		['21046 - Maryland', { kind: 'zip', zip: '21046' }],
		['Maryland', { kind: 'state', state: 'MD' }],
		['md', { kind: 'state', state: 'MD' }],
		['district of columbia', { kind: 'state', state: 'DC' }]
	])('reads %s as a place', (text, place) => {
		expect(parsePlaceText(text)).toEqual(place);
	});

	// Free text must never become a place, or a typo would pick a region by accident.
	it.each(['', '2104', '210466', 'Mary', 'Atlantis', '21046abc', 'javascript:alert(1)'])(
		'reads %j as no place',
		(text) => {
			expect(parsePlaceText(text)).toBeNull();
		}
	);

	it('writes a place back as the text a person would type', () => {
		expect(placeText({ kind: 'zip', zip: '21046' })).toBe('21046');
		expect(placeText({ kind: 'state', state: 'MD' })).toBe('Maryland');
	});
});

describe('suggestPlaces', () => {
	it('offers the ZIPs that start with the digits typed, labelled with their state', () => {
		expect(suggestPlaces('210', ZIPS).map((s) => s.label)).toEqual([
			'21044 - Maryland',
			'21046 - Maryland',
			'21001 - Maryland'
		]);
		expect(suggestPlaces('2104', ZIPS).map((s) => s.label)).toEqual([
			'21044 - Maryland',
			'21046 - Maryland'
		]);
		expect(suggestPlaces('210', ZIPS)[1]?.place).toEqual({ kind: 'zip', zip: '21046' });
	});

	it('offers states by the start of the name or by the code', () => {
		expect(suggestPlaces('mar', ZIPS).map((s) => s.label)).toEqual(['Maryland']);
		expect(suggestPlaces('tx', ZIPS).map((s) => s.label)).toEqual(['Texas']);
	});

	it('offers no ZIP before the table is held, and nothing for an empty field', () => {
		expect(suggestPlaces('210', undefined)).toEqual([]);
		expect(suggestPlaces('  ', ZIPS)).toEqual([]);
	});

	it('offers at most six, so a short prefix does not fill the screen', () => {
		const many: ZipsTable = {
			v: 1,
			rows: Array.from({ length: 10 }, (_, n): ZipsTable['rows'][number] => [
				`1000${n}`,
				'NY',
				40.7,
				-74
			])
		};
		expect(suggestPlaces('1', many)).toHaveLength(6);
	});
});
