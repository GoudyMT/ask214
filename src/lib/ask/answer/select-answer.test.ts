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

	// `.endsWith('.')` alone is satisfied by the marked cut's own '...', so this asserted nothing about the
	// one code path that can end mid-sentence. Both halves now: no bare truncation, and the marker present
	// only when a cut actually happened.
	it('never cuts mid-sentence', () => {
		const body = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} of the passage.`).join(
			' '
		);
		const out = selectAnswer(body, 'passage');
		expect(out.endsWith('.')).toBe(true);
		expect(out.endsWith('...')).toBe(false);
	});

	// A trailing cut is marked; a LEADING cut is the same defect facing the other way. On a benefits
	// document the sentence before the answer is usually the condition or the negation that governs it, so
	// dropping it unmarked lets the app print a statement the source does not make. The opening here is
	// sized to fill the 45-word scoring budget on its own - shorter, and the whole body fits, nothing is
	// selected against, and the test proves nothing.
	it('marks a run that starts mid-passage, so a dropped condition is visible', () => {
		const body =
			'You are not eligible for this payment if any of the following circumstances apply to you at ' +
			'the time that your application is received by the regional office that serves the area where ' +
			'you currently reside and maintain your permanent legal residence. ' +
			'You are currently incarcerated in a federal or state penal institution for a felony conviction. ' +
			'You already receive a similar benefit from another federal agency for the same period.';
		const out = selectAnswer(body, 'incarcerated felony penal institution');
		expect(out).toContain('currently incarcerated');
		expect(out).not.toContain('You are not eligible');
		expect(out.startsWith('...')).toBe(true);
	});

	it('does not mark a run that starts at the opening', () => {
		const body = 'First sentence here. Second sentence here. Third sentence here.';
		expect(selectAnswer(body, 'first').startsWith('...')).toBe(false);
	});

	// `subdivideLists` splits a flattened list on ' - ', and the pieces were rejoined with a plain space -
	// so two independent bullets could render as one continuous statement. The counts are exact on purpose:
	// the fusion needs the two pieces to sum to the ceiling (67) while the first stays under the 45-word
	// target, which is what makes the packer take both. Change a count and the test stops testing this.
	it('keeps two list items from reading as one statement', () => {
		const item = (n: number, w: string) => Array.from({ length: n }, () => w).join(' ');
		const body = `${item(44, 'tuition')} - ${item(23, 'housing')}`;
		const out = selectAnswer(body, 'tuition');
		expect(out).toContain('tuition - housing');
		expect(out).not.toContain('tuition housing');
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
