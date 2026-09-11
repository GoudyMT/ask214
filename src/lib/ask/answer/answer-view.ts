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

// How much a match in the heading or the opening line counts on top of a match anywhere in the chunk, and
// how much a phone number counts when the question asks for one. NOT fitted to the benchmark: both were
// chosen as "enough to overturn a moderate coverage gap, not enough to overrule a large one" and measured
// once. Worth +1.5pp end to end, which fixed 5 of the 20 mention-beats-answer failures and introduced 2
// where the boost overturned a card that was right. A sweep of these values would be fitting to the score
// they are judged by, so it belongs on the tune split or nowhere.
const HEAD_WEIGHT = 0.6;
const CONTACT_WEIGHT = 0.6;
// How much of the chunk counts as its opening. These sources are FAQ-shaped: the chunk that answers usually
// restates the question in its first line.
const OPENING_WORDS = 25;

/** The question is asking how to reach someone, so a passage without a number cannot answer it. */
const CONTACT_INTENT = /\b(?:call|phone|number|hotline|helpline|contact|reach)\b/;
/** A US number as these documents write them: 1-800-827-1000, 877-827-3702, 1-877-222-VETS, 1-855-VA-WOMEN. */
const PHONE = /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\b1-\d{3}-[A-Za-z0-9]{2,}-[A-Za-z0-9]+/;

/**
 * The heading plus the opening line - the part of a chunk that says what it is ABOUT, rather than what it
 * happens to mention. Coverage over the whole chunk cannot tell those apart, which is what let a card that
 * merely name-drops the query's words beat the card that answers.
 */
function headArea(card: ResultCard): string {
	const opening = card.excerpt.split(/\s+/).slice(0, OPENING_WORDS).join(' ');
	return `${card.section ?? ''} ${opening}`;
}

/**
 * Build the extractive answer from the retrieved set.
 *
 * It reads EVERY retrieved card, not just the first. Retrieval is not the weak link: measured end to end on
 * the online path (2026-09-11, `pnpm answer-gate:bge`), the answer sits in SOME retrieved card 85.2% of the
 * time. Choice is. The rendered answer carries it 50.4%, and would carry it 74.1% if the right card were
 * always picked - so roughly 24 points sit inside cards retrieval has already returned.
 *
 * Three signals decide, all multiplied by retrieval's own score so ranking still counts. Term coverage over
 * the whole chunk is the base. A match in the HEADING or opening line counts extra, because coverage alone
 * cannot tell a chunk that answers from one that name-drops the question's words - the dominant failure,
 * where a USERRA card won a "VET TEC" query on incidental mentions. And a chunk carrying a phone number
 * counts extra when the question asks who to call, because a resource listing never repeats the words
 * "call" or "number" and so loses exactly the query it answers.
 *
 * Ties and empty queries keep the retrieval order, which is the honest default.
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

	const wantsContact = CONTACT_INTENT.test(normalize(query));

	let best = cards[0]!;
	let bestScore = -1;
	for (const card of cards) {
		// Three signals, all multiplied by retrieval's own evidence so ranking still counts:
		//   - what the chunk mentions anywhere (the original signal)
		//   - what its heading and opening line are ABOUT, which is what separates answering from mentioning
		//   - whether it carries a number, when a number is what was asked for
		const contact = wantsContact && PHONE.test(card.excerpt) ? CONTACT_WEIGHT : 0;
		const score =
			(coverage(card.excerpt, terms) + HEAD_WEIGHT * coverage(headArea(card), terms) + contact) *
			card.score;
		if (score > bestScore) {
			bestScore = score;
			best = card;
		}
	}

	const passage = stripHeadingEcho(best.excerpt, best.section);
	return {
		text: selectAnswer(passage, query),
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
