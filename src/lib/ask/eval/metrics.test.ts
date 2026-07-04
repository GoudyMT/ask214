import { describe, it, expect } from 'vitest';
import { recallAtK, meanReciprocalRank, hitRateAtK } from './metrics';

// Each query yields a ranked list of chunk ids (best first) + the expected (relevant) ids.
const RANKED = [
	['a', 'b', 'c', 'd', 'e'], // q1: expected 'a' -> rank 1
	['x', 'y', 'b', 'z', 'w'], // q2: expected 'b' -> rank 3
	['m', 'n', 'o', 'p', 'q'] // q3: expected 'z' -> not found
];
const EXPECTED = [['a'], ['b'], ['z']];

describe('recallAtK', () => {
	it('is the fraction of queries with >=1 expected id in the top-k', () => {
		expect(recallAtK(RANKED, EXPECTED, 5)).toBeCloseTo(2 / 3, 6); // q1,q2 hit; q3 miss
		expect(recallAtK(RANKED, EXPECTED, 2)).toBeCloseTo(1 / 3, 6); // only q1 in top-2
	});

	it('returns 0 for an empty query set', () => {
		expect(recallAtK([], [], 5)).toBe(0);
	});
});

describe('meanReciprocalRank', () => {
	it('averages 1/rank of the first expected id (0 when absent)', () => {
		// q1: 1/1, q2: 1/3, q3: 0  -> mean = (1 + 0.3333 + 0) / 3
		expect(meanReciprocalRank(RANKED, EXPECTED)).toBeCloseTo((1 + 1 / 3 + 0) / 3, 6);
	});
});

describe('hitRateAtK', () => {
	it('is an honest alias of recallAtK (>=1 expected id in top-k)', () => {
		expect(hitRateAtK(RANKED, EXPECTED, 5)).toBe(recallAtK(RANKED, EXPECTED, 5));
		expect(hitRateAtK([['a', 'b']], [['b']], 5)).toBe(1);
		expect(hitRateAtK([['a', 'b']], [['c']], 5)).toBe(0);
	});
});
