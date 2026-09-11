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

	it('shows the banner alone when there is no document answer to carry it', () => {
		expect(chooseAnswer({ eligibilityIntent: true })).toEqual({ kind: 'eligibility' });
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
		const answer = toExtractiveAnswer([await card()], 'how long do I have?');
		expect(answer?.text.startsWith('Once you notify us')).toBe(true);
		expect(answer?.passage.startsWith('Once you notify us')).toBe(true);
	});

	it('returns undefined when there are no cards at all', () => {
		expect(toExtractiveAnswer([], 'anything')).toBeUndefined();
	});

	// The answer is chosen across the retrieved SET, not from card 1: end to end the answer sits in SOME
	// retrieved card 85.2% of the time online, far more often than in card 1 alone.
	it('takes the answer from a later card when that card covers the question better', async () => {
		const weak = await card({
			chunkId: 'other_source:0123456789ab',
			sourceTitle: 'Unrelated',
			section: undefined,
			excerpt: 'Burial allowances are described elsewhere in this guide.',
			score: 0.8
		});
		const strong = await card({ score: 0.75 });
		const answer = toExtractiveAnswer(
			[weak, strong],
			'how long do I have to submit my intent to file?'
		);
		expect(answer?.sourceTitle).toBe('VA - Your Intent to File');
		expect(answer?.chunkId).toBe(strong.chunkId);
	});

	// Coverage over the WHOLE chunk rewards a card that mentions the question's words in passing over one
	// that answers it. Measured on the benchmark this was the dominant card-choice failure: a USERRA card
	// won a "VET TEC 2.0" query at 0.83 coverage because "vet", "training" and "benefits" all appear in it.
	// The mention card here genuinely out-scores the answering one under the old rule, so this fails unless
	// the heading actually carries weight.
	it('prefers a card whose heading answers the question over one that only mentions its words', async () => {
		// Both fixtures run past the opening window on purpose. A chunk shorter than that window IS its own
		// opening, so the heading signal could not discriminate and the test would pass or fail for the
		// wrong reason. Real chunks are ~190 words.
		const mentions = await card({
			chunkId: 'other_source:aaaaaaaaaaaa',
			sourceTitle: 'Appendix',
			section: 'Appendix: additional resources',
			excerpt:
				'Appendix of additional resources for separating service members. This appendix lists websites, ' +
				'points of contact and printed material referenced elsewhere in this guide. Entries are grouped ' +
				'by topic and reviewed each year by the program office. Veterans can use these listings to find ' +
				'training programs, technology (TEC) offerings and employment links.',
			score: 0.8
		});
		const answers = await card({
			chunkId: 'other_source:bbbbbbbbbbbb',
			sourceTitle: 'VET TEC',
			section: 'What training can I use VET TEC for?',
			excerpt:
				'What training can I use VET TEC for? VET TEC covers computer software, media, information ' +
				'science and data processing programs. Providers must be approved and the program must be ' +
				'completed within its approved length. A housing allowance may be payable while you are ' +
				'enrolled full time.',
			score: 0.75
		});
		const answer = toExtractiveAnswer([mentions, answers], 'what training can I use VET TEC for');
		expect(answer?.sourceTitle).toBe('VET TEC');
	});

	// A question asking who to call is answered by a phone number, and the chunk holding one is a resource
	// listing that never repeats the words "call" or "number" - so term coverage sinks exactly the card that
	// answers. Six of the sixteen diagnosed card-choice failures were this single shape, one of them a
	// crisis query.
	it('prefers a card carrying a phone number when the question asks who to call', async () => {
		// Coverage figures mirror the measured failure: the prose card scored 0.50 on the question's terms
		// and the listing that actually held the number scored 0.17.
		const prose = await card({
			chunkId: 'other_source:cccccccccccc',
			sourceTitle: 'Applying online',
			section: 'Applying online',
			excerpt:
				'If you apply online, it is recommended you create an account before beginning. This allows ' +
				'you to save your work and return later. You can also call your school certifying official ' +
				'about your GI Bill enrollment once classes begin.',
			score: 0.7
		});
		const listing = await card({
			chunkId: 'other_source:dddddddddddd',
			sourceTitle: 'Key VA resources',
			section: 'Key VA resources',
			excerpt:
				'VA Home Page. The VA.gov website offers current resources, tools and contact information for ' +
				'all VA benefits and services. GI Bill hotline: 1-888-442-4551. Education and training ' +
				'benefits information for service members and veterans.',
			score: 0.72
		});
		const answer = toExtractiveAnswer([prose, listing], 'what number do I call about my GI Bill');
		expect(answer?.sourceTitle).toBe('Key VA resources');
	});

	// The boost must not fire on a question that merely CONTAINS one of those words in another sense.
	// "How long does it take VA to make a decision on my claim" is not a request for a phone number.
	it('does not prefer a phone-bearing card when the question is not asking who to call', async () => {
		const answers = await card({
			chunkId: 'other_source:eeeeeeeeeeee',
			sourceTitle: 'Decision timelines',
			section: 'How long does a decision take?',
			excerpt: 'How long does a decision take? Most disability claims are decided within 100 days.',
			score: 0.75
		});
		const listing = await card({
			chunkId: 'other_source:ffffffffffff',
			sourceTitle: 'Key VA resources',
			section: 'Key VA resources',
			excerpt: 'VA Home Page. Benefits hotline: 1-800-827-1000. Claim status information.',
			score: 0.74
		});
		const answer = toExtractiveAnswer([answers, listing], 'how long does a decision take');
		expect(answer?.sourceTitle).toBe('Decision timelines');
	});

	it('carries the citation through', async () => {
		const c = await card();
		expect(toExtractiveAnswer([c], 'how long do I have?')).toMatchObject({
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
		const keys = Object.keys(toExtractiveAnswer([bare], 'anything') ?? {});
		expect(keys).not.toContain('page');
		expect(keys).not.toContain('section');
		expect(keys).not.toContain('chunkId');
	});
});
