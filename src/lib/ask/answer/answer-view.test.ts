import { describe, expect, it } from 'vitest';
import { deriveChunkId } from '$lib/corpus/chunk-id';
import type { ResultCard } from '$lib/corpus';
import type { CitedAnswer } from '../synthesis/cited-answer';
import { chooseAnswer, toExtractiveAnswer, type ExtractiveAnswer } from './answer-view';

const extractive: ExtractiveAnswer = {
	text: 'You have one year to submit the completed claim.',
	passage: 'You have one year to submit the completed claim. It reserves your effective date.',
	sourceId: 'va_disability_file',
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
	// The safety order turns on WHO WROTE the words. Model prose can reason about the user's own facts,
	// which is what 38 CFR 14.629 forbids, so it is suppressed outright on an eligibility question - even
	// when synthesis succeeded and cleared every other gate.
	it('suppresses a successful synthesized answer on an eligibility question', () => {
		const view = chooseAnswer({
			eligibilityIntent: true,
			synthesis: { kind: 'answer', answer: synthesized },
			extractive
		});
		expect(view?.kind).not.toBe('synthesized');
	});

	// A verbatim quotation from an official document cannot adjudicate anything, so it SURVIVES an
	// eligibility question rather than being replaced by a redirect - which would have swapped the answer
	// away on 28.9% of the benchmark questions, most of them procedural lookups. The 38 CFR note itself is
	// permanent on the block (AskAnswer.svelte), not flagged on here, because the gate reads the question's
	// phrasing and misses cases like "can I use VA health care".
	it('keeps the document answer on an eligibility question', () => {
		expect(chooseAnswer({ eligibilityIntent: true, extractive })).toEqual({
			kind: 'extractive',
			answer: extractive
		});
	});

	// The reader enabled the summary, supplied a key, and the model answered - and then we dropped it for a
	// LEGAL reason they cannot see. Saying nothing leaves them unable to tell "it worked" from "it was
	// withheld", which is the exact disclosure gap synthesisNote exists to close, on the one path where the
	// reason is 38 CFR rather than a failure. Neither existing note can carry it: `refused` would claim an
	// accuracy gate fired, which is false here, and `unavailable` would claim none could be produced.
	it('discloses a synthesis suppressed on an eligibility question', () => {
		const view = chooseAnswer({
			eligibilityIntent: true,
			synthesis: { kind: 'answer', answer: synthesized },
			extractive
		});
		expect(view).toEqual({ kind: 'extractive', answer: extractive, synthesisNote: 'suppressed' });
	});

	// A refusal or an outage on an eligibility question is still a refusal or an outage - the reason the
	// reader is owed is the one that actually happened, not the branch it happened on.
	it('keeps the true reason when synthesis failed on its own before the gate', () => {
		expect(
			chooseAnswer({ eligibilityIntent: true, synthesis: { kind: 'refusal' }, extractive })
		).toEqual({ kind: 'extractive', answer: extractive, synthesisNote: 'refused' });
	});

	it('shows the banner alone when there is no document answer to carry it', () => {
		expect(chooseAnswer({ eligibilityIntent: true })).toEqual({ kind: 'eligibility' });
	});

	// The model classified the question itself, so no prose was ever produced. Claiming one was produced and
	// withheld would be false - the same shape as the `unavailable` copy that once told a reader with no API
	// key that a summary "could not be produced".
	it('does not claim a suppression when the model never produced a summary', () => {
		const view = chooseAnswer({
			eligibilityIntent: true,
			synthesis: { kind: 'eligibility' },
			extractive
		});
		expect(view).toEqual({ kind: 'extractive', answer: extractive });
	});

	it('honours an eligibility verdict reached on the model path too', () => {
		expect(
			chooseAnswer({ eligibilityIntent: false, synthesis: { kind: 'eligibility' }, extractive })
		).toEqual({ kind: 'extractive', answer: extractive });
	});

	// With the note permanent, the gate's only remaining job on this path is suppressing MODEL prose. The
	// extractive shape must therefore be identical either way - no flag, nothing for a renderer to diverge on.
	it('produces the same extractive shape whether or not the gate fired', () => {
		expect(chooseAnswer({ eligibilityIntent: false, extractive })).toEqual(
			chooseAnswer({ eligibilityIntent: true, extractive })
		);
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
	// The fallback itself is unchanged; what is new is that it SAYS SO. A safety gate rejecting the model's
	// answer is information the reader is entitled to - without it, someone who supplied a key and enabled
	// the summary cannot tell "it worked" from "the output was rejected". WHICH gate fired stays a
	// safety-log detail; that one did is not.
	it('falls back to the extractive answer when synthesis refuses, and says so', () => {
		expect(
			chooseAnswer({ eligibilityIntent: false, synthesis: { kind: 'refusal' }, extractive })
		).toEqual({ kind: 'extractive', answer: extractive, synthesisNote: 'refused' });
	});

	// Distinct from a refusal: nothing was produced at all. The deleted AskSummary had separate copy for
	// these two, and collapsing them would tell the reader something that is not true of their case.
	it('falls back to the extractive answer when synthesis is unavailable, and says so', () => {
		expect(
			chooseAnswer({ eligibilityIntent: false, synthesis: { kind: 'unavailable' }, extractive })
		).toEqual({ kind: 'extractive', answer: extractive, synthesisNote: 'unavailable' });
	});

	// The exact-match here now also proves the ABSENCE of a note: the default user never ran synthesis, so
	// telling them one was rejected would be false.
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
		const answer = toExtractiveAnswer([await card()]);
		expect(answer?.text.startsWith('Once you notify us')).toBe(true);
		expect(answer?.passage.startsWith('Once you notify us')).toBe(true);
	});

	it('returns undefined when there are no cards at all', () => {
		expect(toExtractiveAnswer([])).toBeUndefined();
	});

	// REVERSED 2026-09-13, on measurement. Choosing across the retrieved set won +8.1pp on substring
	// containment - and was the mechanism behind 11 of the 17 queries where the answer block shipped
	// misleading text on a question the lead card had rendered safely. Judged blind over all 135 benchmark
	// queries, the block harmed 28 against the card's 20; widening the window to the card's own length
	// improved usefulness but did not move harm at all. The answer is the card retrieval ranked first.
	it('takes the answer from the lead card, even when a later card covers the question better', async () => {
		const weak = await card({
			chunkId: 'other_source:0123456789ab',
			sourceTitle: 'Unrelated',
			section: undefined,
			excerpt: 'Burial allowances are described elsewhere in this guide.',
			score: 0.8
		});
		const strong = await card({ score: 0.75 });
		const answer = toExtractiveAnswer([weak, strong]);
		expect(answer?.chunkId).toBe(weak.chunkId);
	});

	// REMOVED 2026-09-13: three tests covered cross-card scoring - heading weight, contact intent, and the
	// guard against boosting a phone-bearing card on a non-contact query. That mechanism is gone, so the
	// tests went with it rather than being weakened.
	//
	// The failure modes they documented are REAL and remain unfixed at this layer: a card that name-drops the
	// query's words can outrank the card that answers, and a resource listing can lose a "who do I call"
	// query because it never repeats the word "call". Scoring across cards fixed those and cost more than it
	// bought - see toExtractiveAnswer's docblock for the measurement. They are corpus and retrieval problems
	// now, tracked in the corpus-shape cycle spec.

	it('carries the citation through', async () => {
		const c = await card();
		expect(toExtractiveAnswer([c])).toMatchObject({
			sourceId: c.sourceId,
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
		const keys = Object.keys(toExtractiveAnswer([bare]) ?? {});
		expect(keys).not.toContain('page');
		expect(keys).not.toContain('section');
		expect(keys).not.toContain('chunkId');
	});
});
