import { normalizeText } from '../../corpus/normalize';
import type { ExtractionResult } from './pdf-text';

/**
 * PURE HTML-text shaper (A2-D3): takes the Readability article text (the build script makes the actual
 * linkedom + Readability call) and normalizes it into the shared ExtractionResult. `textLayerPresent` is
 * always true for HTML; off-origin hygiene is asserted separately (findOffOriginUrls on the sanitized
 * markup) - the shaper only sees the already-extracted text.
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
