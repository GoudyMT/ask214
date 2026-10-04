import { describe, it, expect } from 'vitest';
import { encodeProfile, decodeProfile, ProfileSchemaError, type ProfileV1 } from './codec';
import { zeroizeRecord } from './lifecycle';

const baseProfile: ProfileV1 = {
	schemaVersion: 1,
	generation: 1,
	lastSeenAt: 1716700000000,
	setupIntent: 'completed',
	setupIntentChangedAt: 1716700000000,
	eaos: new TextEncoder().encode('2027-04-15')
};

describe('encodeProfile / decodeProfile', () => {
	it('roundtrips a minimal profile', () => {
		const enc = encodeProfile(baseProfile);
		expect(enc).toBeInstanceOf(Uint8Array);
		const dec = decodeProfile(enc);
		expect(dec.schemaVersion).toBe(1);
		expect(dec.generation).toBe(1);
		expect(dec.setupIntent).toBe('completed');
		expect(dec.eaos).not.toBeNull();
		if (dec.eaos) expect(new TextDecoder().decode(dec.eaos)).toBe('2027-04-15');
	});

	it('roundtrips a fully-populated profile', () => {
		const full: ProfileV1 = {
			...baseProfile,
			rate: new TextEncoder().encode('IT2'),
			rank: new TextEncoder().encode('E-5'),
			yearsOfService: 9,
			anticipatedDisabilityRating: 30,
			familyStatus: new TextEncoder().encode('married'),
			intendedPath: new TextEncoder().encode('civilian-it'),
			geographicDestination: new TextEncoder().encode('TX'),
			specialSituations: [
				new TextEncoder().encode('combat-vet'),
				new TextEncoder().encode('post-911')
			]
		};
		const dec = decodeProfile(encodeProfile(full));
		expect(dec.yearsOfService).toBe(9);
		expect(dec.anticipatedDisabilityRating).toBe(30);
		expect(dec.rate).toBeDefined();
		if (dec.rate) expect(new TextDecoder().decode(dec.rate)).toBe('IT2');
		expect(dec.specialSituations).toHaveLength(2);
		const first = dec.specialSituations?.[0];
		expect(first).toBeDefined();
		if (first) expect(new TextDecoder().decode(first)).toBe('combat-vet');
	});

	it('preserves a null eaos field', () => {
		const dec = decodeProfile(encodeProfile({ ...baseProfile, eaos: null }));
		expect(dec.eaos).toBeNull();
	});

	it('rejects a schemaVersion mismatch on decode', () => {
		const v2 = new TextEncoder().encode(
			JSON.stringify({
				schemaVersion: 2,
				generation: 0,
				lastSeenAt: 0,
				setupIntent: 'pending',
				setupIntentChangedAt: null,
				eaos: null
			})
		);
		expect(() => decodeProfile(v2)).toThrow(/E_PROFILE_SCHEMA/);
	});

	it('rejects non-JSON bytes on decode', () => {
		expect(() => decodeProfile(new TextEncoder().encode('not json{'))).toThrow(ProfileSchemaError);
	});

	it('encodes deterministically for the same input', () => {
		const a = encodeProfile(baseProfile);
		const b = encodeProfile(baseProfile);
		expect(Array.from(a)).toEqual(Array.from(b));
	});

	it('roundtrips a large field without overflowing (b64 chunking)', () => {
		const big = new Uint8Array(100_000).fill(65);
		const dec = decodeProfile(encodeProfile({ ...baseProfile, rate: big }));
		expect(dec.rate).toBeDefined();
		expect(dec.rate?.length).toBe(100_000);
	});

	it('a legacy record holding the old SkillBridge fields decodes, with both keys dropped', () => {
		const legacy = new TextEncoder().encode(
			JSON.stringify({
				schemaVersion: 1,
				generation: 1,
				lastSeenAt: 0,
				setupIntent: 'completed',
				setupIntentChangedAt: 0,
				eaos: null,
				skillbridgeApproved: 1,
				skillbridgeDurationDays: 180
			})
		);
		const dec = decodeProfile(legacy) as unknown as Record<string, unknown>;
		expect('skillbridgeApproved' in dec).toBe(false);
		expect('skillbridgeDurationDays' in dec).toBe(false);
	});
});

describe('the leaving dates', () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	const base = (): ProfileV1 => ({
		schemaVersion: 1,
		generation: 1,
		lastSeenAt: 0,
		setupIntent: 'completed',
		setupIntentChangedAt: 0,
		eaos: enc('2027-04-30')
	});

	it('round-trips both dates as bytes', () => {
		const p = {
			...base(),
			skillbridgeStart: enc('2026-11-01'),
			terminalLeaveStart: enc('2027-04-01')
		};
		const dec = decodeProfile(encodeProfile(p));
		expect(new TextDecoder().decode(dec.skillbridgeStart)).toBe('2026-11-01');
		expect(new TextDecoder().decode(dec.terminalLeaveStart)).toBe('2027-04-01');
	});

	it('omits a date that is not set, so clearing one drops its key', () => {
		const p = { ...base(), skillbridgeStart: undefined };
		const wire = JSON.parse(new TextDecoder().decode(encodeProfile(p))) as Record<string, unknown>;
		expect('skillbridgeStart' in wire).toBe(false);
		expect('skillbridgeStart' in decodeProfile(encodeProfile(p))).toBe(false);
	});

	it('the new dates are zeroized with the rest of the record on relock', () => {
		const sb = enc('2026-11-01');
		const tl = enc('2027-04-01');
		const p: ProfileV1 = { ...base(), eaos: null, skillbridgeStart: sb, terminalLeaveStart: tl };
		zeroizeRecord(p as unknown as Record<string, unknown>);
		expect(sb.every((b) => b === 0)).toBe(true);
		expect(tl.every((b) => b === 0)).toBe(true);
	});
});
