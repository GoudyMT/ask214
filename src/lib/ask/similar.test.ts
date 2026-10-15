import { describe, it, expect } from 'vitest';
import type { ResultCard } from '$lib/corpus';
import { similarCards } from './similar';

const card = (excerpt: string): ResultCard => ({
	sourceId: 's',
	sourceTitle: 'S',
	chunkId: `s:${excerpt.length}`,
	excerpt,
	url: 'https://www.va.gov/',
	score: 0.8
});

describe('similarCards', () => {
	it('drops the lead and keeps the rest in order', () => {
		const cards = [
			card('lead text here'),
			card('one two three four five six seven eight nine'),
			card('a b c d e f g h i j')
		];
		expect(similarCards(cards)).toEqual([cards[1], cards[2]]);
	});

	// Eight words is the longest heading measured among the shown cards; nine words are kept.
	it('leaves out a passage of eight words or fewer, and keeps nine', () => {
		const eight = card('Military OneSource Services for Military Separation and More');
		const nine = card('Who is covered by this program after you leave');
		expect(similarCards([card('lead'), eight, nine])).toEqual([nine]);
	});

	it('counts words, not characters, and ignores extra spaces', () => {
		expect(similarCards([card('lead'), card('  Ages   30   to   34  ')])).toEqual([]);
	});

	it('returns nothing for a lone lead or no cards', () => {
		expect(similarCards([card('lead')])).toEqual([]);
		expect(similarCards([])).toEqual([]);
	});
});
