import { normalizeText } from '../../corpus/normalize';
import type { Block, ExtractionResult } from './pdf-text';

/** One block element pulled from the article DOM by the linkedom walk in capture-extract.mjs:
 *  its own inline text + its lowercased tag, in document order, already de-nested. */
export type RawBlock = { text: string; tag: string };

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Shape a de-nested ordered block sequence into the shared ExtractionResult. A heading sets the
 * section for itself and the blocks under it (until the next heading); each block's text is
 * normalized; normalizedText is the flat normalized join - the space anchors resolve in. Pure.
 */
export function shapeHtmlBlocks(sequence: RawBlock[]): ExtractionResult {
	const blocks: Block[] = [];
	let section: string | undefined;
	for (const raw of sequence) {
		const text = normalizeText(raw.text);
		if (text.length === 0) continue;
		if (HEADING_TAGS.has(raw.tag.toLowerCase())) section = text;
		blocks.push(section === undefined ? { text } : { text, section });
	}
	return {
		normalizedText: normalizeText(blocks.map((b) => b.text).join('\n')),
		blocks,
		textLayerPresent: true,
		extractionMode: 'html'
	};
}
