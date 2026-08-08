import { describe, it, expect } from 'vitest';
import { shouldDegrade, DAILY_NEURON_BUDGET, DEGRADE_AT } from './budget';

describe('shouldDegrade (circuit-breaker math)', () => {
	const line = DAILY_NEURON_BUDGET * DEGRADE_AT;

	it('serves normally below the safety line', () => {
		expect(shouldDegrade(0)).toBe(false);
		expect(shouldDegrade(Math.floor(DAILY_NEURON_BUDGET * 0.5))).toBe(false);
		expect(shouldDegrade(line - 1)).toBe(false);
	});

	it('degrades at or past the safety line', () => {
		expect(shouldDegrade(line)).toBe(true);
		expect(shouldDegrade(Math.ceil(line) + 1)).toBe(true);
	});
});
