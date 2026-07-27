import { describe, it, expect } from 'vitest';
import { detectEligibilityIntent } from './eligibility-gate';

describe('detectEligibilityIntent', () => {
	it('short-circuits a first-person eligibility query', () => {
		expect(
			detectEligibilityIntent('I have a 30% rating and served 8 years, what am I entitled to?')
				.shortCircuit
		).toBe(true);
	});
	it('short-circuits a second-person "do I qualify" query', () => {
		expect(detectEligibilityIntent('Do I qualify for the housing grant?').shortCircuit).toBe(true);
	});
	it('does NOT short-circuit a general informational query', () => {
		expect(detectEligibilityIntent('What is the SkillBridge program?').shortCircuit).toBe(false);
	});
	it('does NOT short-circuit an impersonal criteria question', () => {
		expect(
			detectEligibilityIntent('What are the eligibility rules for VA disability compensation?')
				.shortCircuit
		).toBe(false);
	});
});
