import { describe, it, expect } from 'vitest';
import { EXAMPLE_QUESTIONS } from './example-questions';

describe('EXAMPLE_QUESTIONS', () => {
	it('is a non-empty curated list of questions', () => {
		expect(EXAMPLE_QUESTIONS.length).toBeGreaterThanOrEqual(6);
		for (const q of EXAMPLE_QUESTIONS) {
			expect(typeof q).toBe('string');
			expect(q.trim().endsWith('?')).toBe(true); // each is a question
		}
	});

	it('avoids personalized-eligibility phrasing (38 CFR boundary)', () => {
		for (const q of EXAMPLE_QUESTIONS) {
			expect(/\b(am i eligible|do i qualify|will i get|how much will i)\b/i.test(q)).toBe(false);
		}
	});
});
