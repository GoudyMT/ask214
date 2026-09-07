import type { ResultCard } from '$lib/corpus';
import type { CitedAnswer } from '../synthesis/cited-answer';
import type { SynthesisView } from '../synthesis/synthesis-view';
import { stripHeadingEcho } from './heading-echo';
import { selectAnswer } from './select-answer';

/** The answer taken from the document itself: `text` is the short answer, `passage` its expansion. */
export type ExtractiveAnswer = {
	text: string;
	passage: string;
	sourceTitle: string;
	url: string;
	chunkId?: string;
	page?: number;
	section?: string;
};

/**
 * The single answer slot. Exactly one occupant, ever - the surface must never carry two blocks that both
 * claim to be the answer, which is why this is a union rather than a pair of optional fields.
 */
export type AnswerView =
	| { kind: 'extractive'; answer: ExtractiveAnswer }
	| { kind: 'synthesized'; answer: CitedAnswer }
	| { kind: 'eligibility' }
	| { kind: 'notCovered' };

/**
 * The synthesis outcomes that can reach the slot. Crisis cannot: the store commits a terminal crisis state
 * before any answer is computed, on the keyword path and the model path alike. Excluding it here makes
 * that a compiler check rather than a comment that can rot.
 */
export type SlotSynthesis = Exclude<SynthesisView, { kind: 'crisis' }>;

/**
 * Build the extractive answer for a result card.
 *
 * @param card The top result card; its excerpt is the full cleaned chunk text, untruncated.
 * @param query The user's question, used to choose which sentences answer it.
 * @returns Both tiers plus the card's citation.
 */
export function toExtractiveAnswer(card: ResultCard, query: string): ExtractiveAnswer {
	const passage = stripHeadingEcho(card.excerpt, card.section);
	return {
		text: selectAnswer(passage, query),
		passage,
		sourceTitle: card.sourceTitle,
		url: card.url,
		...(card.chunkId !== undefined ? { chunkId: card.chunkId } : {}),
		...(card.page !== undefined ? { page: card.page } : {}),
		...(card.section !== undefined ? { section: card.section } : {})
	};
}

/**
 * Decide which single occupant fills the answer slot.
 *
 * The order IS the safety order. An eligibility question never renders a block that reads as an
 * adjudication of the user's own facts, whatever else is available to show - and a question the sources do
 * not cover says so rather than showing the nearest thing. Only below those does an answer appear, the
 * model's when it cleared every gate, otherwise the document's own sentences.
 *
 * @param input The eligibility verdict for this query, the synthesis outcome when there was one, and the
 *   extractive answer when a card produced one.
 * @returns The slot's occupant, or undefined to leave the result cards standing alone.
 */
export function chooseAnswer(input: {
	eligibilityIntent: boolean;
	synthesis?: SlotSynthesis;
	extractive?: ExtractiveAnswer;
}): AnswerView | undefined {
	if (input.eligibilityIntent || input.synthesis?.kind === 'eligibility') {
		return { kind: 'eligibility' };
	}
	if (input.synthesis?.kind === 'notCovered') return { kind: 'notCovered' };
	if (input.synthesis?.kind === 'answer') {
		return { kind: 'synthesized', answer: input.synthesis.answer };
	}
	// A chunk that selects to nothing renders no block at all, rather than an empty one above the cards.
	if (input.extractive && input.extractive.text !== '') {
		return { kind: 'extractive', answer: input.extractive };
	}
	return undefined;
}
