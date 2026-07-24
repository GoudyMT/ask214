import { describe, it, expect } from 'vitest';
import { blocksToNormalizedText } from './derive-normalized';

describe('blocksToNormalizedText', () => {
	it('joins block texts with the extractor separator and normalizes, so each block text is an in-order substring', () => {
		const blocks = [
			{ text: 'First block.', page: 1 },
			{ text: 'Second block.', page: 2 }
		];
		const nt = blocksToNormalizedText(blocks);
		let cursor = 0;
		for (const b of blocks) {
			const idx = nt.indexOf(b.text, cursor);
			expect(idx).toBeGreaterThanOrEqual(0); // the split.ts invariant
			cursor = idx + b.text.length;
		}
	});
});
