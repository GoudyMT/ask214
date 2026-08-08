import { describe, it, expect } from 'vitest';
import { checkNumericGrounding } from './grounding';

describe('checkNumericGrounding', () => {
	it('passes when every number in the answer appears in the cited text', () => {
		const r = checkNumericGrounding(
			'The rate is $3,737 as of 2026.',
			'Compensation is $3,737 effective 2026.'
		);
		expect(r.grounded).toBe(true);
	});
	it('flags a number absent from the cited text (hallucinated figure)', () => {
		const r = checkNumericGrounding('You get $9,999 monthly.', 'Compensation varies by rating.');
		expect(r.grounded).toBe(false);
		expect(r.ungrounded).toContain('9,999');
	});
	it('passes an answer with no numeric tokens (nothing to ground)', () => {
		const r = checkNumericGrounding(
			'SkillBridge lets you train with an employer before separation.',
			'SkillBridge is an authorized transition program.'
		);
		expect(r.grounded).toBe(true);
		expect(r.ungrounded).toEqual([]);
	});
	it('flags a fabricated number that only appears as a substring of a larger number', () => {
		// "5" must not count as grounded just because "2025" contains a 5 (standalone-token match).
		const r = checkNumericGrounding('You are rated at 5%.', 'The 2025 handbook lists ratings.');
		expect(r.grounded).toBe(false);
		expect(r.ungrounded).toContain('5');
	});
	it('grounds a digit in the answer against a spelled-out number in the source', () => {
		// A source figure written as a word ("ten") still grounds the digits the model writes ("10").
		const r = checkNumericGrounding(
			'You need 10 years of service.',
			'Retirement requires ten years of service.'
		);
		expect(r.grounded).toBe(true);
		expect(r.ungrounded).toEqual([]);
	});
	it('grounds a standalone integer that matches exactly', () => {
		const r = checkNumericGrounding('The deadline is 30 days.', 'You have 30 days to respond.');
		expect(r.grounded).toBe(true);
	});
});
