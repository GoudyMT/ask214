import { describe, expect, it } from 'vitest';
import { ANSWER_PROPERTIES, violatedProperties } from './answer-properties';

// Every fixture here is a real string the corpus once rendered, or a minimal reduction of one. A tidy
// invented fixture filters out exactly the cases these properties exist to catch.
describe('violatedProperties', () => {
	it('passes ordinary guidance', () => {
		expect(
			violatedProperties(
				'You can apply online, by mail, in person, or with the help of a trained professional.',
				{}
			)
		).toEqual([]);
	});

	describe('condition-attached', () => {
		it('flags a determination whose governing condition was dropped', () => {
			expect(
				violatedProperties(
					"You're eligible for VA health care. This includes all Veterans who served in the Vietnam War.",
					{
						section:
							'If you served in certain locations and time periods during the Vietnam War era'
					}
				)
			).toContain('condition-attached');
		});

		it('passes when the answer carries the condition', () => {
			expect(
				violatedProperties(
					"If you served in certain locations and time periods during the Vietnam War era You're eligible for VA health care.",
					{
						section:
							'If you served in certain locations and time periods during the Vietnam War era'
					}
				)
			).toEqual([]);
		});

		// The property keys on the section being a CONDITION, so an ordinary label heading is not its business.
		it('passes a determination under a label heading', () => {
			expect(
				violatedProperties("You're eligible for VA health care.", {
					section: 'Eligibility for VA Health Care'
				})
			).toEqual([]);
		});
	});

	describe('no-graded-exercise', () => {
		it('flags a true/false statement bank', () => {
			expect(
				violatedProperties(
					'RESUME QUIZ TRUE FALSE 1. The number one rule for writing a good resume is "more is better."',
					{}
				)
			).toContain('no-graded-exercise');
		});

		it('flags a module question table', () => {
			expect(
				violatedProperties('Module Question Number Answer PG Page Module 1 1 b.', {})
			).toContain('no-graded-exercise');
		});

		// The appendix that ANSWERS a quiz is real guidance and must survive: it states the claim and then
		// resolves it. Removing it once destroyed 3,056 characters of DOL resume guidance.
		it('passes an answer appendix that resolves each claim', () => {
			expect(
				violatedProperties(
					'1. The number one rule for writing a good resume is "more is better." FALSE: An employer reviews a resume, on average, less than 30 seconds.',
					{}
				)
			).toEqual([]);
		});
	});

	describe('no-page-chrome', () => {
		it('flags a whole-block chrome answer', () => {
			expect(violatedProperties('Was this page helpful?', {})).toContain('no-page-chrome');
		});

		// Matching is whole-block and exact because the shortest chunks are overwhelmingly real content -
		// premium rate rows, application steps, headings - which a length or substring rule would destroy.
		it('passes a sentence that merely contains the phrase', () => {
			expect(
				violatedProperties('Tell us whether this page was helpful so we can improve it.', {})
			).toEqual([]);
		});
	});

	describe('no-answer-key-row', () => {
		it('flags an answer-key table row', () => {
			expect(violatedProperties('4 d. There is no deadline Page 41 Module 2 5 b.', {})).toContain(
				'no-answer-key-row'
			);
		});

		it('passes prose that cites a page and a module', () => {
			expect(
				violatedProperties(
					'Module 2 covers the benefits briefing; see page 41 for the checklist.',
					{}
				)
			).toEqual([]);
		});
	});

	it('exposes every property with a stable id and a description', () => {
		for (const p of ANSWER_PROPERTIES) {
			expect(p.id).toMatch(/^[a-z0-9-]+$/);
			expect(p.describe.length).toBeGreaterThan(0);
		}
		expect(new Set(ANSWER_PROPERTIES.map((p) => p.id)).size).toBe(ANSWER_PROPERTIES.length);
	});
});
