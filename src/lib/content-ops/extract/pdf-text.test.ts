import { describe, test, expect } from 'vitest';
import { assemblePdfText } from './pdf-text';

describe('assemblePdfText', () => {
	test('joins text items per page into normalized text + page blocks', () => {
		const r = assemblePdfText([
			[{ str: 'Hello' }, { str: ' world.', hasEOL: true }],
			[{ str: 'Page two.' }]
		]);
		expect(r.extractionMode).toBe('pdf');
		expect(r.textLayerPresent).toBe(true);
		expect(r.normalizedText).toContain('Hello world.');
		expect(r.normalizedText).toContain('Page two.');
		expect(r.blocks.map((b) => b.page)).toEqual([1, 2]);
	});

	test('a page with no text layer yields pdf_scanned, not a crash', () => {
		const r = assemblePdfText([[]]);
		expect(r.textLayerPresent).toBe(false);
		expect(r.extractionMode).toBe('pdf_scanned');
		expect(r.normalizedText).toBe('');
	});
});
