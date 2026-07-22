import { describe, it, expect } from 'vitest';
import { EXAMPLE_QUESTIONS } from './example-questions';

// Personalized-eligibility phrasing, anchored on a first-person construction so a document name like
// "Certificate of Eligibility" (no "I") never matches. The curated list must stay behind this 38 CFR
// boundary, and the guard must actually catch the class - not just a few literal phrasings.
const PERSONALIZED_ELIGIBILITY =
	/\b(am i (eligible|entitled)|do i (qualify|rate)|will i (get|qualify|receive|be eligible)|can i (get|claim)|how much (will|can|do|would) i|what('| i)s my (rating|disability rating|benefit)|what rating (will|would|do|could) i|should i (file|claim))\b/i;

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
			expect(PERSONALIZED_ELIGIBILITY.test(q)).toBe(false);
		}
	});

	it('the eligibility guard actually catches personalized-eligibility phrasings', () => {
		const disallowed = [
			'Am I eligible for VA disability?',
			'Will I qualify for VA disability compensation?',
			'Am I entitled to a housing allowance?',
			'How much can I get for a 70% rating?',
			'What rating would I receive for tinnitus?',
			'Should I file a claim for my knee?',
			'Do I rate BAH after separation?'
		];
		for (const q of disallowed) {
			expect(PERSONALIZED_ELIGIBILITY.test(q)).toBe(true);
		}
	});
});
