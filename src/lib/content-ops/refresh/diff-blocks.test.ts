import { describe, it, expect } from 'vitest';
import { diffBlocks } from './diff-blocks';

describe('diffBlocks', () => {
	it('reports added and removed blocks keyed by normalized text', () => {
		const oldB = ['Intro paragraph.', 'Shared paragraph.'];
		const newB = ['Shared paragraph.', 'A new inserted paragraph.'];
		const d = diffBlocks(oldB, newB);
		expect(d.added).toEqual(['A new inserted paragraph.']);
		expect(d.removed).toEqual(['Intro paragraph.']);
	});

	it('ignores whitespace-only reformatting (normalizeText collapses runs)', () => {
		const d = diffBlocks(['One   two'], ['One two']);
		expect(d.added).toEqual([]);
		expect(d.removed).toEqual([]);
	});

	it('returns empty diffs for identical block sets', () => {
		const d = diffBlocks(['a', 'b'], ['a', 'b']);
		expect(d.added).toEqual([]);
		expect(d.removed).toEqual([]);
	});
});
