import { describe, test, expect } from 'vitest';
import { shapeHtmlExtraction } from './html-text';

describe('shapeHtmlExtraction', () => {
	test('normalizes the article text into an html ExtractionResult', () => {
		const r = shapeHtmlExtraction('  Submit your   claim\n online.  ');
		expect(r.extractionMode).toBe('html');
		expect(r.textLayerPresent).toBe(true);
		expect(r.normalizedText).toBe('Submit your claim online.');
		expect(r.blocks).toHaveLength(1);
		expect(r.blocks[0]?.text).toBe('Submit your claim online.');
	});

	test('empty article text yields empty normalized text but stays html mode', () => {
		const r = shapeHtmlExtraction('   ');
		expect(r.normalizedText).toBe('');
		expect(r.extractionMode).toBe('html');
	});
});
