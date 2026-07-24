import { normalizeText } from '$lib/corpus/normalize';
import type { Block } from '$lib/content-ops/extract/pdf-text';

// The exact join used by both extraction paths (assemblePdfText's per-page blocks, shapeHtmlBlocks'
// per-element blocks) before the single normalizeText pass. Must match verbatim - a different
// separator changes where whitespace collapses and breaks the in-order substring contract below.
const SEP = '\n';

/**
 * Re-derives normalizedText from block texts the same way the extractor does, so each block's text
 * remains a verbatim, in-order substring of the result. The clean stage calls this after dropping or
 * editing blocks (removing boilerplate) so the rebuilt normalizedText still satisfies the invariant
 * that split.ts's mapBlockOffsets relies on: normalizedText.indexOf(block.text, cursor) must succeed,
 * in block order, for every surviving block.
 *
 * Args:
 *     blocks: The (possibly cleaned) blocks, in reading order. Only `text` is read.
 *
 * Returns:
 *     The normalized text rebuilt from the given blocks.
 */
export function blocksToNormalizedText(blocks: Pick<Block, 'text'>[]): string {
	return normalizeText(blocks.map((b) => b.text).join(SEP));
}
