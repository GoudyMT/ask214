import { describe, expect, it } from 'vitest';
import { STATE_CODES, type StateCode } from './places';
import { STATE_EXTENTS, isInStateExtent } from './state-extents';

const WITHOUT_BOX: readonly StateCode[] = ['AS', 'GU', 'MP', 'VI'];

describe('STATE_EXTENTS', () => {
	it('names only states and holds sane boxes', () => {
		const known: ReadonlySet<string> = new Set(STATE_CODES);
		for (const [code, box] of Object.entries(STATE_EXTENTS)) {
			expect(known.has(code), code).toBe(true);
			const [south, west, north, east] = box;
			expect(south, code).toBeLessThan(north);
			expect(west, code).toBeLessThan(east);
			expect(Math.abs(south) <= 90 && Math.abs(north) <= 90, code).toBe(true);
			expect(Math.abs(west) <= 180 && Math.abs(east) <= 180, code).toBe(true);
		}
	});

	it('covers the 50 states, DC and Puerto Rico, and not the territories without Census counties', () => {
		for (const code of STATE_CODES)
			expect(STATE_EXTENTS[code] !== undefined, code).toBe(!WITHOUT_BOX.includes(code));
	});
});

describe('isInStateExtent', () => {
	it('holds a real point in its own state', () => {
		expect(isInStateExtent('MD', 39.2, -76.86)).toBe(true);
		expect(isInStateExtent('HI', 21.3, -157.85)).toBe(true);
		expect(isInStateExtent('AK', 61.2, -149.9)).toBe(true);
	});

	it('tells a point filed under the wrong state', () => {
		expect(isInStateExtent('AK', 13.47, 144.75)).toBe(false);
	});

	// Alaska reaches past 180 degrees west, but its box must not reach east across Asia and Europe.
	it('finds an Alaska point with a flipped longitude outside Alaska', () => {
		expect(isInStateExtent('AK', 61.2, 149.9)).toBe(false);
		expect(isInStateExtent('AK', 61.2, -149.9)).toBe(true);
	});

	// A flipped longitude and the 0,0 default are the two wrong coordinates the listings really carry.
	it('finds the flipped longitude and 0,0 in no state', () => {
		for (const code of STATE_CODES) {
			expect(isInStateExtent(code, 39.2, 76.86), code).not.toBe(true);
			expect(isInStateExtent(code, 0, 0), code).not.toBe(true);
		}
	});

	it('has no answer for a territory without a box', () => {
		expect(isInStateExtent('GU', 13.47, 144.75)).toBeUndefined();
	});
});
