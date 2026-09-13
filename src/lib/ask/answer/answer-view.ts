import type { ResultCard } from '$lib/corpus';
import type { CitedAnswer } from '../synthesis/cited-answer';
import type { SynthesisView } from '../synthesis/synthesis-view';
import { stripHeadingEcho } from './heading-echo';
import { selectAnswer } from './select-answer';

/** The answer taken from the document itself: `text` is the short answer, `passage` its expansion. */
export type ExtractiveAnswer = {
	text: string;
	passage: string;
	// Which source this was taken from. Required, because the answer is chosen across the retrieved set and
	// is NOT necessarily the lead card - the reader has to be opened on the document the answer actually
	// quotes, not on whatever happened to rank first.
	sourceId: string;
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
	| {
			kind: 'extractive';
			answer: ExtractiveAnswer;
			/**
			 * Set when this answer is STANDING IN for a synthesis that did not reach the reader: `refused`
			 * when the model answered and a safety gate rejected it (an ungrounded figure, an invalid
			 * citation), `unavailable` when none could be produced. Absent when synthesis never ran, which
			 * is every default user.
			 *
			 * The slot still holds exactly one answer - this is a note ON it, not a second block. It exists
			 * because dropping the old refusal/unavailable states took their disclosure with them, leaving a
			 * reader who enabled the summary and supplied a key unable to tell "it worked" from "the model
			 * output was rejected". WHICH gate fired stays a safety-log detail; that one did is the reader's.
			 */
			synthesisNote?: 'refused' | 'unavailable';
	  }
	| { kind: 'synthesized'; answer: CitedAnswer }
	| { kind: 'eligibility' }
	| { kind: 'notCovered' };

/**
 * The synthesis outcomes that can reach the slot. Crisis cannot: the store commits a terminal crisis state
 * before any answer is computed, on the keyword path and the model path alike. Excluding it here makes
 * that a compiler check rather than a comment that can rot.
 */
export type SlotSynthesis = Exclude<SynthesisView, { kind: 'crisis' }>;

// Words too common to carry query signal - the same small list the selector uses, for the same reason.
/**
 * Build the extractive answer from the card retrieval ranked first.
 *
 * It deliberately does NOT choose across the retrieved set, and that reversal is the whole point. Scoring
 * every card on term coverage, heading match and contact intent won +8.1pp on substring containment, and it
 * was the mechanism behind 11 of the 17 queries where this block shipped text a reader would be misled by
 * on a question the lead card had rendered safely.
 *
 * Measured by blind paired judgement over all 135 benchmark queries (2026-09-13): the answer block put
 * misleading text on screen for 28 queries against the lead card's 20. Widening the window to the card's own
 * length raised how often the block answered - 62 to 66 - and moved harm by nothing, because truncating at
 * any budget severs something and what separated the two surfaces was WHICH card got truncated.
 *
 * So the block now renders the lead card's own passage, and its harm equals that card's by construction.
 * What the block adds over the bare card is the second tier, the route into the source document, and the
 * standing 38 CFR note - not a different choice of text.
 *
 * Do NOT re-introduce cross-card scoring without re-running the harm comparison; substring containment
 * cannot see this failure, and rose while harm rose with it.
 *
 * @param cards The retrieved cards in retrieval order; each excerpt is full cleaned chunk text.
 * @returns Both tiers plus the lead card's citation, or undefined when there are no cards.
 */
export function toExtractiveAnswer(cards: ResultCard[]): ExtractiveAnswer | undefined {
	const best = cards[0];
	if (best === undefined) return undefined;

	const passage = stripHeadingEcho(best.excerpt, best.section);
	return {
		text: selectAnswer(passage),
		passage,
		sourceId: best.sourceId,
		sourceTitle: best.sourceTitle,
		url: best.url,
		...(best.chunkId !== undefined ? { chunkId: best.chunkId } : {}),
		...(best.page !== undefined ? { page: best.page } : {}),
		...(best.section !== undefined ? { section: best.section } : {})
	};
}

/**
 * Decide which single occupant fills the answer slot.
 *
 * The order IS the safety order, and it turns on WHO WROTE the words. On an eligibility question the
 * model's prose is suppressed outright - it can reason about the user's facts, which is the thing 38 CFR
 * 14.629 forbids. The document's own sentences are not suppressed, because a verbatim quotation cannot
 * adjudicate anything; they carry the banner instead. Below that, a question the sources do not cover says
 * so rather than showing the nearest thing.
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
		// The model answer is dropped here even when it succeeded, because model prose CAN reason about the
		// user's facts. The document's own sentences survive: a verbatim quotation cannot adjudicate.
		//
		// Nothing is flagged onto the answer here. The 38 CFR note is PERMANENT on every extractive answer
		// rather than conditional on this gate, because the gate keys on the question's phrasing and so
		// misses the cases that matter most - "can I USE VA health care" renders "You're eligible for VA
		// health care" and never trips it, since `use` is a deliberately excluded procedural verb. The note
		// is not a conditional warning; it is a standing description of what the block is, and it is true on
		// every query. See AskAnswer.svelte.
		return input.extractive && input.extractive.text !== ''
			? { kind: 'extractive', answer: input.extractive }
			: { kind: 'eligibility' };
	}
	if (input.synthesis?.kind === 'notCovered') return { kind: 'notCovered' };
	if (input.synthesis?.kind === 'answer') {
		return { kind: 'synthesized', answer: input.synthesis.answer };
	}
	// A chunk that selects to nothing renders no block at all, rather than an empty one above the cards.
	if (input.extractive && input.extractive.text !== '') {
		const note =
			input.synthesis?.kind === 'refusal'
				? ('refused' as const)
				: input.synthesis?.kind === 'unavailable'
					? ('unavailable' as const)
					: undefined;
		return {
			kind: 'extractive',
			answer: input.extractive,
			...(note !== undefined ? { synthesisNote: note } : {})
		};
	}
	return undefined;
}
