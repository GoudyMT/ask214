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

// Words too common to carry query signal - the same small list the selector uses, for the same reason.
const STOP_WORDS = new Set(
	(
		'what how when where why who which the a an of to for and or in on at is are do does i my me ' +
		'you your can if it that this with be been will would should'
	).split(' ')
);

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The share of the query's content terms that appear anywhere in `text`. */
function coverage(text: string, terms: Set<string>): number {
	if (terms.size === 0) return 0;
	const haystack = normalize(text);
	let hit = 0;
	for (const term of terms) if (haystack.includes(term)) hit++;
	return hit / terms.size;
}

/**
 * Build the extractive answer from the retrieved set.
 *
 * It reads EVERY retrieved card, not just the first. Measured end to end on the project's benchmark, the
 * answer sits inside card 1 only 27.4% of the time but inside SOME retrieved card 59.3% of the time, so
 * taking card 1 unconditionally discarded most of what retrieval had already found: 31.9% of queries put
 * the right passage in a later card while a wrong answer sat on top of it. Choosing across the set moved
 * the end-to-end score from 24.4% to 31.1%, against 25.9% for the card this replaces.
 *
 * The card is chosen by query-term coverage over its whole text, multiplied by its retrieval score - so
 * retrieval's own evidence still counts rather than being thrown away for a keyword count. Ties and empty
 * queries keep the retrieval order, which is the honest default.
 *
 * @param cards The retrieved cards in retrieval order; each excerpt is full cleaned chunk text.
 * @param query The user's question.
 * @returns Both tiers plus the citation of the card the answer was actually taken from, or undefined when
 *   there are no cards.
 */
export function toExtractiveAnswer(
	cards: ResultCard[],
	query: string
): ExtractiveAnswer | undefined {
	if (cards.length === 0) return undefined;
	const terms = new Set(
		normalize(query)
			.split(' ')
			.filter((w) => w.length > 2 && !STOP_WORDS.has(w))
	);

	let best = cards[0]!;
	let bestScore = -1;
	for (const card of cards) {
		const score = coverage(card.excerpt, terms) * card.score;
		if (score > bestScore) {
			bestScore = score;
			best = card;
		}
	}

	const passage = stripHeadingEcho(best.excerpt, best.section);
	return {
		text: selectAnswer(passage, query),
		passage,
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
		return { kind: 'extractive', answer: input.extractive };
	}
	return undefined;
}
