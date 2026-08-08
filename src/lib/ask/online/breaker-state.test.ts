import { describe, it, expect } from 'vitest';
import { advance, isTripped } from './breaker-state';
import { DAILY_NEURON_BUDGET, DEGRADE_AT } from './budget';

const DAY = '2026-07-29';
const NEXT = '2026-07-30';
const line = DAILY_NEURON_BUDGET * DEGRADE_AT;

describe('advance (daily neuron counter)', () => {
	it('starts a fresh tally when there is no prior state', () => {
		expect(advance(null, DAY, 5)).toEqual({ day: DAY, spent: 5 });
	});
	it('accumulates within the same UTC day', () => {
		expect(advance({ day: DAY, spent: 10 }, DAY, 5)).toEqual({ day: DAY, spent: 15 });
	});
	it('resets the tally on a new UTC day', () => {
		expect(advance({ day: DAY, spent: 9999 }, NEXT, 5)).toEqual({ day: NEXT, spent: 5 });
	});
});

describe('isTripped (degrade decision)', () => {
	it('is not tripped with no prior state', () => {
		expect(isTripped(null, DAY)).toBe(false);
	});
	it('is not tripped below the safety line', () => {
		expect(isTripped({ day: DAY, spent: line - 1 }, DAY)).toBe(false);
	});
	it('is tripped at or past the safety line', () => {
		expect(isTripped({ day: DAY, spent: line }, DAY)).toBe(true);
	});
	it('is not tripped when the stored day is stale (fresh day resets)', () => {
		expect(isTripped({ day: DAY, spent: DAILY_NEURON_BUDGET }, NEXT)).toBe(false);
	});
});
