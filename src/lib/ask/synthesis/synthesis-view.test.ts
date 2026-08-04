import { describe, it, expect } from 'vitest';
import { toSynthesisView } from './synthesis-view';
import type { CitedAnswer } from './cited-answer';

const answer: CitedAnswer = {
	text: 'File through eBenefits [tap_moc].',
	citations: [{ id: 'tap_moc', url: 'https://va.gov', title: 'VA' }],
	inert: [],
	disclaimer: 'AI-generated - verify against the official sources.'
};

describe('toSynthesisView', () => {
	it('maps an answer to a cited-summary view carrying the CitedAnswer', () => {
		expect(toSynthesisView({ kind: 'answer', answer })).toEqual({ kind: 'answer', answer });
	});

	it('maps eligibility to the impersonal-info view', () => {
		expect(toSynthesisView({ kind: 'eligibility' })).toEqual({ kind: 'eligibility' });
	});

	it('maps every refusal reason to a single refusal view (see the sources)', () => {
		for (const reason of ['invalid_citation', 'ungrounded_number', 'no_citations'] as const) {
			expect(toSynthesisView({ kind: 'refusal', reason })).toEqual({ kind: 'refusal' });
		}
	});

	it('maps degraded to the unavailable view (no banner; cards stand alone)', () => {
		expect(toSynthesisView({ kind: 'degraded' })).toEqual({ kind: 'unavailable' });
	});
});
