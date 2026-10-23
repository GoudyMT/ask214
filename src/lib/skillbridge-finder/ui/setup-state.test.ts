import { describe, it, expect } from 'vitest';
import { isSetUp, withSetupChoices } from './setup-state';

describe('isSetUp', () => {
	it('is false for a record never set up, and true once setup was skipped or answered', () => {
		expect(isSetUp({})).toBe(false);
		expect(isSetUp({ territories: false, overseas: false })).toBe(true);
		expect(
			isSetUp({ place: { kind: 'state', state: 'MD' }, territories: false, overseas: false })
		).toBe(true);
	});
});

describe('withSetupChoices', () => {
	// A person who changes where they look must not lose the branch and length they picked in the list.
	it('replaces format and field and keeps the filters the list owns', () => {
		expect(
			withSetupChoices(
				{ delivery: [1], industries: ['Management'], branches: ['Navy'], durations: ['1-30'] },
				{ delivery: [2] }
			)
		).toEqual({ delivery: [2], branches: ['Navy'], durations: ['1-30'] });
	});

	it('clears format and field when the answer holds none', () => {
		expect(withSetupChoices({ delivery: [1], industries: ['Management'] }, {})).toEqual({});
	});
});
