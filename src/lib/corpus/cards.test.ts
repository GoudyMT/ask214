import { describe, it, expect } from 'vitest';
import { toResultCards } from './cards';
import type { RetrievalResult } from './types';

function result(over: Partial<RetrievalResult['chunk']>, score: number): RetrievalResult {
	return {
		score,
		chunk: {
			id: 'a',
			text: 'full chunk text',
			sourceId: 'va_welcome_kit',
			sourceTitle: 'VA Welcome Kit',
			tags: [],
			url: 'https://va.gov/x',
			...over
		}
	};
}

describe('toResultCards', () => {
	it('maps results to citation-complete cards (excerpt falls back to full text)', () => {
		const [card] = toResultCards([result({ page: 3, section: 'Benefits' }, 0.9)]);
		expect(card).toEqual({
			sourceId: 'va_welcome_kit',
			sourceTitle: 'VA Welcome Kit',
			page: 3,
			section: 'Benefits',
			excerpt: 'full chunk text',
			url: 'https://va.gov/x',
			score: 0.9
		});
	});

	it('prefers chunk.excerpt over chunk.text when present', () => {
		const [card] = toResultCards([result({ excerpt: 'short excerpt' }, 0.5)]);
		expect(card!.excerpt).toBe('short excerpt');
	});

	it('omits page/section entirely when the chunk has none (no undefined keys)', () => {
		const [card] = toResultCards([result({}, 0.5)]);
		expect('page' in card!).toBe(false);
		expect('section' in card!).toBe(false);
	});
});
