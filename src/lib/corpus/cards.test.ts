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
			chunkId: 'a',
			page: 3,
			section: 'Benefits',
			excerpt: 'full chunk text',
			url: 'https://va.gov/x',
			score: 0.9
		});
	});

	it('carries the chunk id so the reader can highlight the cited passage', () => {
		const [card] = toResultCards([result({ id: 'va_welcome_kit:abc123def456' }, 0.9)]);
		expect(card!.chunkId).toBe('va_welcome_kit:abc123def456');
	});

	it('prefers chunk.excerpt over chunk.text when present', () => {
		const [card] = toResultCards([result({ excerpt: 'short excerpt' }, 0.5)]);
		expect(card!.excerpt).toBe('short excerpt');
	});

	it('cleans display artifacts (fused version footer, inline bullet glyphs) from the excerpt', () => {
		const SQUARE = String.fromCodePoint(0x25a0); // black square list bullet, as extracted
		const [card] = toResultCards([
			result({ text: 'A-160Version 6 1 September 2025 VA Resources ' + SQUARE + ' myVA' }, 0.9)
		]);
		expect(card!.excerpt).toBe('VA Resources - myVA');
	});

	it('omits page/section entirely when the chunk has none (no undefined keys)', () => {
		const [card] = toResultCards([result({}, 0.5)]);
		expect('page' in card!).toBe(false);
		expect('section' in card!).toBe(false);
	});
});
