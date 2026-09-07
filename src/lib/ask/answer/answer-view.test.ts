import { describe, expect, it } from 'vitest';
import { deriveChunkId } from '$lib/corpus/chunk-id';
import type { ResultCard } from '$lib/corpus';
import type { CitedAnswer } from '../synthesis/cited-answer';
import { chooseAnswer, toExtractiveAnswer, type ExtractiveAnswer } from './answer-view';

const extractive: ExtractiveAnswer = {
	text: 'You have one year to submit the completed claim.',
	passage: 'You have one year to submit the completed claim. It reserves your effective date.',
	sourceTitle: 'VA - Your Intent to File',
	url: 'https://www.va.gov/'
};

const synthesized: CitedAnswer = {
	text: 'Once you notify VA of your intent to file, you have one year to submit the claim.',
	citations: [{ id: 'x', url: 'https://www.va.gov/', title: 'VA - Your Intent to File' }],
	inert: [],
	disclaimer: 'AI-generated - verify against the official sources.'
};

describe('chooseAnswer', () => {
	// The safety order. An eligibility question must never render a block that reads as an adjudication of
	// the user's own facts, whatever else is available to show (38 CFR 14.629).
	it('puts eligibility above everything, including a good synthesized answer', () => {
		expect(
			chooseAnswer({
				eligibilityIntent: true,
				synthesis: { kind: 'answer', answer: synthesized },
				extractive
			})
		).toEqual({ kind: 'eligibility' });
	});

	it('honours an eligibility verdict reached on the model path too', () => {
		expect(
			chooseAnswer({ eligibilityIntent: false, synthesis: { kind: 'eligibility' }, extractive })
		).toEqual({ kind: 'eligibility' });
	});

	it('maps notCovered to the boundary state rather than showing an answer anyway', () => {
		expect(
			chooseAnswer({ eligibilityIntent: false, synthesis: { kind: 'notCovered' }, extractive })
		).toEqual({ kind: 'notCovered' });
	});

	it('prefers a successful synthesized answer over the extractive one', () => {
		expect(
			chooseAnswer({
				eligibilityIntent: false,
				synthesis: { kind: 'answer', answer: synthesized },
				extractive
			})
		).toEqual({ kind: 'synthesized', answer: synthesized });
	});

	// This is what the one-slot decision bought: both of these used to render an apology over raw cards.
	it('falls back to the extractive answer when synthesis refuses', () => {
		expect(
			chooseAnswer({ eligibilityIntent: false, synthesis: { kind: 'refusal' }, extractive })
		).toEqual({ kind: 'extractive', answer: extractive });
	});

	it('falls back to the extractive answer when synthesis is unavailable', () => {
		expect(
			chooseAnswer({ eligibilityIntent: false, synthesis: { kind: 'unavailable' }, extractive })
		).toEqual({ kind: 'extractive', answer: extractive });
	});

	it('uses the extractive answer when there is no synthesis at all (the device path)', () => {
		expect(chooseAnswer({ eligibilityIntent: false, extractive })).toEqual({
			kind: 'extractive',
			answer: extractive
		});
	});

	it('returns undefined when there is nothing to show, leaving the cards alone', () => {
		expect(chooseAnswer({ eligibilityIntent: false })).toBeUndefined();
	});

	// A chunk that selects to nothing must not render an empty answer block above the cards.
	it('returns undefined when the extractive answer is empty', () => {
		expect(
			chooseAnswer({ eligibilityIntent: false, extractive: { ...extractive, text: '' } })
		).toBeUndefined();
	});

	// A crisis answer can never reach this slot: the store commits a terminal crisis state before any
	// answer is computed, so rendering one here would put benefits copy where 988 belongs. That is
	// enforced by the TYPE, and this asserts the type still enforces it - @ts-expect-error fails the build
	// if the call ever starts compiling, which is exactly what widening SlotSynthesis would do.
	it('cannot be handed a crisis view', () => {
		// The input is typed, so the incompatibility lands on the property itself and cannot drift onto
		// another line when the formatter rewraps the call.
		const input: Parameters<typeof chooseAnswer>[0] = {
			eligibilityIntent: false,
			// @ts-expect-error crisis is excluded from SlotSynthesis by design
			synthesis: { kind: 'crisis' }
		};
		// And if one ever did arrive, the fall-through is silence, not benefits copy over a crisis.
		expect(chooseAnswer(input)).toBeUndefined();
	});
});

describe('toExtractiveAnswer', () => {
	// The id is DERIVED from the shipped identity rule, not written down: a colon-free slug fixture is
	// exactly what hid a shipped defect on the synthesis path for an entire release.
	const EXCERPT =
		'Your Intent to File Once you notify us of your intent to file you have one year to submit the completed claim.';

	async function card(overrides: Partial<ResultCard> = {}): Promise<ResultCard> {
		return {
			sourceId: 'va_disability_file',
			sourceTitle: 'VA - Your Intent to File',
			chunkId: await deriveChunkId('va_disability_file', EXCERPT),
			section: 'Your Intent to File',
			page: 3,
			excerpt: EXCERPT,
			url: 'https://www.va.gov/',
			score: 0.7,
			...overrides
		};
	}

	it('strips the heading echo from both tiers', async () => {
		const answer = toExtractiveAnswer(await card(), 'how long do I have?');
		expect(answer.text.startsWith('Once you notify us')).toBe(true);
		expect(answer.passage.startsWith('Once you notify us')).toBe(true);
	});

	it('carries the citation through', async () => {
		const c = await card();
		expect(toExtractiveAnswer(c, 'how long do I have?')).toMatchObject({
			sourceTitle: c.sourceTitle,
			url: c.url,
			page: 3,
			chunkId: c.chunkId
		});
	});

	it('omits absent optional fields rather than setting them undefined', async () => {
		const bare = await card();
		delete bare.page;
		delete bare.section;
		delete bare.chunkId;
		const keys = Object.keys(toExtractiveAnswer(bare, 'anything'));
		expect(keys).not.toContain('page');
		expect(keys).not.toContain('section');
		expect(keys).not.toContain('chunkId');
	});
});
