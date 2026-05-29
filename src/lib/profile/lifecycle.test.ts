import { describe, it, expect } from 'vitest';
import { zeroizeField, freezeRelock } from './lifecycle';

describe('zeroizeField', () => {
	it('fills a Uint8Array with zeros in place', () => {
		const buf = new Uint8Array([1, 2, 3, 4]);
		zeroizeField(buf);
		expect(Array.from(buf)).toEqual([0, 0, 0, 0]);
	});

	it('zeroes each Uint8Array element of an array and clears the array', () => {
		const a = new Uint8Array([1, 2]);
		const b = new Uint8Array([3, 4]);
		const arr = [a, b];
		zeroizeField(arr);
		expect(Array.from(a)).toEqual([0, 0]);
		expect(Array.from(b)).toEqual([0, 0]);
		expect(arr.length).toBe(0);
	});

	it('is a no-op for null / undefined / primitives', () => {
		expect(() => zeroizeField(null)).not.toThrow();
		expect(() => zeroizeField(undefined)).not.toThrow();
		expect(() => zeroizeField(42)).not.toThrow();
		expect(() => zeroizeField('string')).not.toThrow();
		expect(() => zeroizeField({ foo: 'bar' })).not.toThrow();
	});

	it('handles nested array containing non-Uint8Array entries gracefully', () => {
		const u = new Uint8Array([7, 8]);
		const arr = [u, 'not a buffer' as unknown as Uint8Array];
		zeroizeField(arr);
		expect(Array.from(u)).toEqual([0, 0]);
		expect(arr.length).toBe(0);
	});
});

describe('freezeRelock', () => {
	it('zeroes byte fields in place and clears byte arrays, leaving primitives', () => {
		const profile = {
			eaos: new Uint8Array([0x32, 0x30, 0x32, 0x37]),
			specialSituations: [new Uint8Array([0x61, 0x62])],
			generation: 5,
			setupIntentChangedAt: null
		};
		freezeRelock(profile);
		expect(Array.from(profile.eaos)).toEqual([0, 0, 0, 0]);
		expect(profile.specialSituations.length).toBe(0);
		expect(profile.generation).toBe(5);
		expect(profile.setupIntentChangedAt).toBeNull();
	});

	it('returns synchronously (void, not a Promise)', () => {
		const r = freezeRelock({ eaos: new Uint8Array(4) });
		expect(r).toBeUndefined();
	});
});
