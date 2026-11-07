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

	// Rate, rank, family status and intended path were asked by no screen; a profile can still hold them from an old
	// backup. Nothing shows from them, so the persona drops them: they are read the same as a date alone.
	it('reads a profile holding the four old answers exactly as one with the date alone', () => {
		const today = new Date('2026-05-26T12:00:00Z');
		const old = withEaos({
			rate: new TextEncoder().encode('IT2'),
			rank: new TextEncoder().encode('E-5'),
			familyStatus: new TextEncoder().encode('married'),
			intendedPath: new TextEncoder().encode('school')
		});
		expect(derivePersona(old, today)).toEqual(derivePersona(withEaos(), today));
	});

	describe('the leaving dates', () => {
		const enc = (s: string) => new TextEncoder().encode(s);

		it('carries each date in use', () => {
			const r = derivePersona(
				withEaos({ skillbridgeStart: enc('2026-11-01'), terminalLeaveStart: enc('2027-04-01') })
			);
			expect(r.completeness).toBe('eaos-only');
			if (r.completeness === 'none') return;
			expect(r.leaving).toEqual({
				skillbridgeStart: '2026-11-01',
				terminalLeaveStart: '2027-04-01'
			});
		});

		it('carries no leaving field when neither date is set', () => {
			const r = derivePersona(withEaos());
			if (r.completeness === 'none') throw new Error('expected a persona');
			expect('leaving' in r).toBe(false);
		});

		it('does not use a date on or after separation, and says which', () => {
			const r = derivePersona(
				withEaos({ skillbridgeStart: enc('2027-04-15'), terminalLeaveStart: enc('2027-05-01') })
			);
			if (r.completeness === 'none') throw new Error('expected a persona');
			expect(r.leaving).toEqual({
				notUsed: { skillbridgeStart: '2027-04-15', terminalLeaveStart: '2027-05-01' }
			});
		});

		it.each([
			['a calendar-invalid date', enc('2026-13-40')],
			['bytes that are not text', new Uint8Array([0xff, 0xfe])]
		])(
			'reads %s as not set, leaving the separation date and completeness alone',
			(_name, bytes) => {
				const r = derivePersona(
					withEaos({ skillbridgeStart: bytes, terminalLeaveStart: enc('2027-04-01') })
				);
				expect(r.completeness).toBe('eaos-only');
				if (r.completeness === 'none') return;
				expect(r.eaos).toBe('2027-04-15');
				expect(r.leaving).toEqual({ terminalLeaveStart: '2027-04-01' });
			}
		);
	});

	describe('the leaving answer', () => {
		const enc = (s: string) => new TextEncoder().encode(s);

		it('carries the answer beside the date', () => {
			const r = derivePersona(withEaos({ separationPath: enc('medical') }));
			expect(r.completeness).toBe('eaos-only');
			if (r.completeness === 'none') return;
			expect(r.separationPath).toBe('medical');
		});

		it('carries no answer when none is stored', () => {
			const r = derivePersona(withEaos());
			if (r.completeness === 'none') throw new Error('expected a persona');
			expect('separationPath' in r).toBe(false);
		});

		it('reads a value this release does not know as not answered, leaving the rest alone', () => {
			const r = derivePersona(withEaos({ separationPath: enc('discharge') }));
			expect(r.completeness).toBe('eaos-only');
			if (r.completeness === 'none') return;
			expect('separationPath' in r).toBe(false);
		});

		// The backup leaves out an answer it would refuse to restore, so the timeline must not act on it either.
		it('reads a known answer behind a byte-order mark as not answered, as the backup does', () => {
			const r = derivePersona(
				withEaos({ separationPath: enc(String.fromCharCode(0xfeff) + 'ets') })
			);
			if (r.completeness === 'none') throw new Error('expected a persona');
			expect('separationPath' in r).toBe(false);
		});
	});
});
