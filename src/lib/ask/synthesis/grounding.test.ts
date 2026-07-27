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
});
