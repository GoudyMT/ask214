import { normalizeText } from '../../corpus/normalize';

export type BlockDiff = { added: string[]; removed: string[] };

// Set-difference over the extracted blocks (the extractor already emits structured blocks), keyed by normalizeText so a
// whitespace-only reformat is not flagged as a content change. Returns the ORIGINAL block text so the review
// report shows the real words a legal reviewer must judge.
export function diffBlocks(oldBlocks: string[], newBlocks: string[]): BlockDiff {
	const oldKeys = new Set(oldBlocks.map(normalizeText));
	const newKeys = new Set(newBlocks.map(normalizeText));
	return {
		added: newBlocks.filter((b) => !oldKeys.has(normalizeText(b))),
		removed: oldBlocks.filter((b) => !newKeys.has(normalizeText(b)))
	};
}
