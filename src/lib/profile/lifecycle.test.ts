import { describe, it, expect } from 'vitest';
import { zeroizeField, freezeRelock, nextLockState } from './lifecycle';

describe('nextLockState', () => {
	it('page hygiene on an open store lands in evicted - a restore may undo it', () => {
		expect(nextLockState('unlocked', 'hygiene')).toBe('evicted');
	});

	it('every non-hygiene reason lands in locked - a restore may not undo it', () => {
		expect(nextLockState('unlocked', 'idle')).toBe('locked');
		expect(nextLockState('unlocked', 'user')).toBe('locked');
		expect(nextLockState('unlocked', 'peer')).toBe('locked');
	});

	// The ladder only descends. pagehide fires after an explicit Lock too, so letting hygiene
	// rewrite `locked` back to `evicted` is exactly how a persisted pageshow silently undoes the
	// Lock the user asked for.
	it('hygiene never downgrades an already-locked store back to restorable', () => {
		expect(nextLockState('locked', 'hygiene')).toBe('locked');
	});

	it('an intentional relock upgrades an evicted store, closing the restore', () => {
		expect(nextLockState('evicted', 'idle')).toBe('locked');
		expect(nextLockState('evicted', 'user')).toBe('locked');
		expect(nextLockState('evicted', 'peer')).toBe('locked');
	});

	// pagehide and freeze both reach the same handler and their order is unsettled across
	// browsers, so the second fire must be a no-op rather than a state change.
	it('is idempotent, so a repeated relock of the same kind changes nothing', () => {
		expect(nextLockState('evicted', 'hygiene')).toBe('evicted');
		expect(nextLockState('locked', 'user')).toBe('locked');
	});
});

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
