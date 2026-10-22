import { describe, it, expect } from 'vitest';
import { validateRegionFile } from '../contract/validate';
import { CLEAN_CASES } from './clean';

// Prongs B and C build their screens and stores on these; if the contract tightens, this fails here first
// instead of in a screen test that only knows its data stopped rendering.
describe('the clean fixtures', () => {
	it('all pass the published-file validator', () => {
		expect(
			validateRegionFile({
				v: 1,
				pullDate: '2026-10-21',
				file: 'south-atlantic',
				listings: Object.values(CLEAN_CASES)
			})
		).toEqual({ valid: true, errors: [] });
	});
});
