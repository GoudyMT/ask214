import { describe, expect, it } from 'vitest';
import { selectAnswer } from './select-answer';

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

describe('selectAnswer', () => {
	it('returns the whole body when it is under the target', () => {
		const body = 'You have one year to submit the completed claim.';
		expect(selectAnswer(body, 'how long do I have to file?')).toBe(body);
	});

	// The opening has to be long enough to fill the budget on its own, or selection has nothing to choose
	// between - everything fits and including the opening is correct behavior, not a scoring failure.
	it('picks the run that matches the query, not the opening', () => {
		const body =
			'This chapter introduces the benefits and services available to you and your family after separation from military service. ' +
			'It is organized into four modules that follow the order of the transition timeline. ' +
			'Each module ends with a short checklist you can complete at your own pace. ' +
			'A burial allowance helps cover the cost of a funeral and a burial plot. ' +
			'Contact your transition coordinator for scheduling.';
		const out = selectAnswer(body, 'what is the burial allowance?');
		expect(out).toContain('burial allowance helps cover');
		expect(out).not.toContain('This chapter introduces');
	});

	it('never cuts mid-sentence', () => {
		const body = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} of the passage.`).join(
			' '
		);
		expect(selectAnswer(body, 'passage').endsWith('.')).toBe(true);
	});

	// The list has no sentence terminator, so it reads as one 50-word sentence. Against a strict 45-word
	// target the packer takes the 5-word lead-in and stops immediately before the answer; the 1.5x ceiling
	// is what lets it absorb the list instead. Shorten this fixture and the test stops testing anything.
	it('absorbs an unterminated list rather than stopping right before the answer', () => {
		const body =
			'You will need several documents. ' +
			'Submit your DD214 your separation health assessment your dependency records your marriage ' +
			'certificate your birth certificates your direct deposit information your service treatment ' +
			'records and any private medical evidence you want us to consider including statements from ' +
			'people who served with you and any evidence of continued treatment after separation';
		expect(selectAnswer(body, 'what documents do I need to submit?')).toContain('DD214');
	});

	it('does not treat an abbreviation period as a sentence end', () => {
		const body =
			'Apply through the U.S. Department of Veterans Affairs within one year of separation.';
		expect(selectAnswer(body, 'where do I apply?')).toBe(body);
	});

	it('falls back to the opening when the query carries no content terms', () => {
		const body = 'First sentence here. Second sentence here. Third sentence here.';
		expect(selectAnswer(body, 'what is it')).toContain('First sentence');
	});

	it('stays within the ceiling', () => {
		const body = Array.from({ length: 40 }, (_, i) => `Filler sentence ${i} about benefits.`).join(
			' '
		);
		expect(words(selectAnswer(body, 'benefits'))).toBeLessThanOrEqual(68); // 45 * 1.5
	});

	it('returns an empty string for an empty body', () => {
		expect(selectAnswer('   ', 'anything')).toBe('');
	});
});
