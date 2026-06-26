import { normalizeText } from '../../corpus/normalize';

export type PdfItem = { str: string; hasEOL?: boolean };
export type Block = { text: string; page?: number; section?: string };

/** The shared SourceExtractor output shape; the HTML shaper returns the same. */
export type ExtractionResult = {
	normalizedText: string;
	blocks: Block[];
	textLayerPresent: boolean;
	extractionMode: 'html' | 'pdf' | 'pdf_scanned';
};

/**
 * Assembles pdfjs `getTextContent()` items (passed in as plain data) into reading-order text +
 * per-page normalized blocks. A page with no text layer yields `textLayerPresent: false` /
 * `pdf_scanned` so that source can ship a page-cite with no anchor rather than a wrong highlight.
 * pdfjs item order is taken as reading order here. Pure.
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
