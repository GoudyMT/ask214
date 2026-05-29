import { describe, it, expect } from 'vitest';
import { derivePersona } from './persona';
import type { ProfileV1 } from './types';

const withEaos = (extra: Partial<ProfileV1> = {}): ProfileV1 => ({
	schemaVersion: 1,
	generation: 1,
	lastSeenAt: 0,
	setupIntent: 'completed',
	setupIntentChangedAt: 0,
	eaos: new TextEncoder().encode('2027-04-15'),
	...extra
});

describe('derivePersona', () => {
	it('returns completeness "none" when the profile is null', () => {
		expect(derivePersona(null).completeness).toBe('none');
	});

	it('returns "none" when EAOS is missing', () => {
		const profile: ProfileV1 = {
			schemaVersion: 1,
			generation: 1,
			lastSeenAt: 0,
			setupIntent: 'pending',
			setupIntentChangedAt: null,
			eaos: null
		};
		expect(derivePersona(profile).completeness).toBe('none');
	});

	it('returns "none" when the EAOS bytes are not a valid date', () => {
		const profile = withEaos({ eaos: new TextEncoder().encode('2027-99-99') });
		expect(derivePersona(profile).completeness).toBe('none');
	});

	it('returns "eaos-only" with daysUntilSeparation when only EAOS is present', () => {
		const today = new Date('2026-05-26T12:00:00Z');
		const r = derivePersona(withEaos(), today);
		expect(r.completeness).toBe('eaos-only');
		if (r.completeness === 'eaos-only') {
			expect(r.eaos).toBe('2027-04-15');
			expect(r.daysUntilSeparation).toBe(324);
		}
	});

	it('returns "partial" when EAOS + one identity field are present', () => {
		const r = derivePersona(withEaos({ rate: new TextEncoder().encode('IT2') }));
		expect(r.completeness).toBe('partial');
		if (r.completeness === 'partial') expect(r.eaos).toBe('2027-04-15');
	});

	it('returns "complete" when EAOS + rate + rank + family + path are present', () => {
		const r = derivePersona(
			withEaos({
				rate: new TextEncoder().encode('IT2'),
				rank: new TextEncoder().encode('E-5'),
				familyStatus: new TextEncoder().encode('married'),
				intendedPath: new TextEncoder().encode('civilian-it')
			})
		);
		expect(r.completeness).toBe('complete');
	});
});
