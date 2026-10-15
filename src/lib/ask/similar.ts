import type { ResultCard } from '$lib/corpus';

/**
 * The most words a passage can have and still be a heading cut off from its text. Every shown card this short,
 * across the benchmark's 155 questions, was one ("DOW SkillBridge", "Option 1: Online Request a COE"): it
 * answers nothing, and it took a place in the Similar list.
 */
export const HEADING_MAX_WORDS = 8;

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/**
 * The cards the Similar list shows: every card after the lead, less passages of only a few words.
 *
 * The lead is never filtered. It is the card the answer is measured on, and changing which card leads would move
 * the answer gate's numbers.
 *
 * @param cards The retrieved cards in retrieval order.
 * @returns The cards after the lead, in order, with heading-only passages left out.
 */
export function similarCards(cards: readonly ResultCard[]): ResultCard[] {
	return cards.slice(1).filter((c) => wordCount(c.excerpt) > HEADING_MAX_WORDS);
}
