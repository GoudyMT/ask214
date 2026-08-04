import type { SynthesisResult } from './synthesize';
import type { CitedAnswer } from './cited-answer';

// The render-ready mapping of a SynthesisResult. `answer` is the Option-B cited summary; `eligibility` is
// the impersonal general-info + VSO/va.gov banner; `refusal` collapses all three refusal reasons to one
// "see the official sources" note (the reason is a safety-log detail, not user-facing); `unavailable` is the
// synthesis-degraded case, which shows NO banner - the raw cards stand alone under a small muted note.
export type SynthesisView =
	| { kind: 'answer'; answer: CitedAnswer }
	| { kind: 'eligibility' }
	| { kind: 'refusal' }
	| { kind: 'unavailable' };

/**
 * Map a synthesis outcome to the banner view the Ask UI renders.
 *
 * @param result The discriminated synthesize outcome.
 * @returns The render-ready view; total over all four SynthesisResult kinds.
 */
export function toSynthesisView(result: SynthesisResult): SynthesisView {
	switch (result.kind) {
		case 'answer':
			return { kind: 'answer', answer: result.answer };
		case 'eligibility':
			return { kind: 'eligibility' };
		case 'refusal':
			return { kind: 'refusal' };
		case 'degraded':
			return { kind: 'unavailable' };
	}
}
