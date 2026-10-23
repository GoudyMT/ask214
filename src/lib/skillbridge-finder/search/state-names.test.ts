import { describe, it, expect } from 'vitest';
import { STATE_CODES } from '../contract/places';
import { STATE_NAMES } from './state-names';

describe('STATE_NAMES', () => {
	// A listing is found by "maryland" only if its code has a name; two codes sharing one would cross-match.
	it('names every code once, with no two codes sharing a name', () => {
		expect(Object.keys(STATE_NAMES).sort()).toEqual([...STATE_CODES].sort());
		for (const code of STATE_CODES) expect(STATE_NAMES[code].length).toBeGreaterThan(0);
		expect(new Set(Object.values(STATE_NAMES)).size).toBe(STATE_CODES.length);
	});

	it('uses the official names for the District and the five territories', () => {
		expect([
			STATE_NAMES.DC,
			STATE_NAMES.AS,
			STATE_NAMES.GU,
			STATE_NAMES.MP,
			STATE_NAMES.PR,
			STATE_NAMES.VI
		]).toEqual([
			'District of Columbia',
			'American Samoa',
			'Guam',
			'Northern Mariana Islands',
			'Puerto Rico',
			'U.S. Virgin Islands'
		]);
	});
});
