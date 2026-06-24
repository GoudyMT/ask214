import { normalizeText } from '../../corpus/normalize';

export type PdfItem = { str: string; hasEOL?: boolean };
export type Block = { text: string; page?: number; section?: string };

/** The shared SourceExtractor output shape (spec section 4); the HTML shaper returns the same. */
export type ExtractionResult = {
	normalizedText: string;
	blocks: Block[];
	textLayerPresent: boolean;
	extractionMode: 'html' | 'pdf' | 'pdf_scanned';
};

/**
 * PURE pdfjs-text assembler (A2-D2): takes pdfjs `getTextContent()` items per page (as plain data - the
 * build script makes the actual pdfjs call) and assembles reading-order text + per-page blocks, normalized
 * (A1-D5). A page with no text layer -> `textLayerPresent: false` / `pdf_scanned` (that source's chunks
 * ship a page-cite with NO anchor in A3 - never a wrong highlight). pdfjs item order IS the reading order
 * here; the A2-D6 cross-tool agreement check is what catches a source where that order is wrong.
 */
export function assemblePdfText(pages: PdfItem[][]): ExtractionResult {
	const blocks: Block[] = [];
	const pageTexts: string[] = [];
	let anyText = false;
	pages.forEach((items, i) => {
		let pageText = '';
		for (const item of items) {
			if (item.str.length > 0) anyText = true;
			pageText += item.str + (item.hasEOL ? '\n' : '');
		}
		const normPage = normalizeText(pageText);
		blocks.push({ text: normPage, page: i + 1 });
		pageTexts.push(normPage);
	});
	return {
		normalizedText: normalizeText(pageTexts.join('\n')),
		blocks,
		textLayerPresent: anyText,
		extractionMode: anyText ? 'pdf' : 'pdf_scanned'
	};
}
