import { describe, it, expect } from 'vitest';
import { toSynthesisView } from './synthesis-view';
import type { CitedAnswer } from './cited-answer';

const answer: CitedAnswer = {
	// Marker-free (toCitedAnswer strips them) and a real chunk-id shape.
	text: 'File through eBenefits.',
	citations: [{ id: 'va_ebenefits:3f9c1a7d2e05', url: 'https://va.gov', title: 'VA' }],
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

	// The two authorized out-of-source outcomes. They are separate views, never collapsed into refusal -
	// collapsing them is what made a crisis reply render as 'we couldn't produce a reliable summary'.
	it('maps the crisis outcome to its own view, never to a refusal', () => {
		expect(toSynthesisView({ kind: 'crisis' })).toEqual({ kind: 'crisis' });
	});

	it('maps the not-covered outcome to its own view, never to a refusal', () => {
		expect(toSynthesisView({ kind: 'notCovered' })).toEqual({ kind: 'notCovered' });
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
