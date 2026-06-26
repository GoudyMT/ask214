import { normalizeText } from '../../corpus/normalize';
import type { ExtractionResult } from './pdf-text';

/**
 * Pure HTML-text shaper: normalizes already-extracted Readability article text into the shared
 * ExtractionResult. `textLayerPresent` is always true for HTML; off-origin URL hygiene is asserted
 * separately on the sanitized markup, so the shaper only ever sees the extracted text.
 */
export function shapeHtmlExtraction(articleText: string): ExtractionResult {
	const normalizedText = normalizeText(articleText);
	return {
		normalizedText,
		blocks: [{ text: normalizedText }],
		textLayerPresent: true,
		extractionMode: 'html'
	};
}
