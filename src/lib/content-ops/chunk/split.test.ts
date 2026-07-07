import { describe, it, expect } from 'vitest';
import { splitIntoSpans } from './split';
import type { Block } from '../extract/pdf-text';

// A stub tokenizer: 1 token per whitespace-delimited word. Deterministic + dependency-free for unit tests
// (the real WordPiece tokenizer is injected only in the orchestrator).
const words = (t: string): number => (t.trim() === '' ? 0 : t.trim().split(/\s+/).length);

// Build the normalizedText the way the block extractor does: per-block normalized text joined by single spaces.
function nt(blocks: Block[]): string {
	return blocks.map((b) => b.text).join(' ');
}

describe('splitIntoSpans', () => {
	it('packs consecutive same-section blocks up to the token target into one chunk', () => {
		const blocks: Block[] = [
			{ text: 'alpha beta', section: 'S1' },
			{ text: 'gamma delta', section: 'S1' }
		];
		const spans = splitIntoSpans(nt(blocks), blocks, words, { targetTokens: 10 });
		expect(spans.length).toBe(1);
		expect(spans[0]?.text).toBe('alpha beta gamma delta');
		expect(spans[0]?.section).toBe('S1');
		expect(spans[0]?.brokeAtTokenLevel).toBe(false);
	});

	it('starts a new chunk at a section boundary even when the token budget is not full', () => {
		const blocks: Block[] = [
			{ text: 'one two', section: 'A' },
			{ text: 'three four', section: 'B' }
		];
		const spans = splitIntoSpans(nt(blocks), blocks, words, { targetTokens: 100 });
		expect(spans.map((s) => s.section)).toEqual(['A', 'B']);
		expect(spans.map((s) => s.text)).toEqual(['one two', 'three four']);
	});

	it('emits a new chunk when adding the next block would exceed the target', () => {
		const blocks: Block[] = [
			{ text: 'a b c', section: 'S' },
			{ text: 'd e f', section: 'S' }
		];
		const spans = splitIntoSpans(nt(blocks), blocks, words, { targetTokens: 3 });
		expect(spans.map((s) => s.text)).toEqual(['a b c', 'd e f']);
	});

	it('splits an oversized block at sentence boundaries (no mid-sentence break)', () => {
		const blocks: Block[] = [
			{ text: 'One two three. Four five six. Seven eight nine.', section: 'S' }
		];
		const spans = splitIntoSpans(nt(blocks), blocks, words, { targetTokens: 3 });
		expect(spans.map((s) => s.text)).toEqual([
			'One two three.',
			'Four five six.',
			'Seven eight nine.'
		]);
		expect(spans.every((s) => s.brokeAtTokenLevel === false)).toBe(true);
	});

	it('falls to token-level windows only when a single sentence exceeds the target', () => {
		const blocks: Block[] = [{ text: 'w1 w2 w3 w4 w5', section: 'S' }];
		const spans = splitIntoSpans(nt(blocks), blocks, words, { targetTokens: 2 });
		expect(spans.every((s) => s.brokeAtTokenLevel === true)).toBe(true);
		expect(spans.map((s) => s.text).join(' ')).toBe('w1 w2 w3 w4 w5');
	});

	it('throws E_CHUNK_BLOCK_NOT_LOCATED when a block is not a verbatim substring of normalizedText', () => {
		const blocks: Block[] = [{ text: 'beta', section: 'S' }];
		expect(() => splitIntoSpans('alpha gamma', blocks, words, { targetTokens: 100 })).toThrow(
			'E_CHUNK_BLOCK_NOT_LOCATED'
		);
	});

	it('force-emits a single word that alone exceeds the target (token-window progress guarantee)', () => {
		// 1 token per non-space char, so each 4-char word exceeds target 3 and must be forced out alone.
		const chars = (t: string): number => t.replaceAll(' ', '').length;
		const blocks: Block[] = [{ text: 'aaaa bbbb', section: 'S' }];
		const spans = splitIntoSpans(nt(blocks), blocks, chars, { targetTokens: 3 });
		expect(spans.map((s) => s.text)).toEqual(['aaaa', 'bbbb']);
		expect(spans.every((s) => s.brokeAtTokenLevel === true)).toBe(true);
	});

	it('leaves a short trailing chunk as its own span when merging it would exceed the window', () => {
		const blocks: Block[] = [
			{ text: 'a b c d', section: 'S' },
			{ text: 'e', section: 'S' }
		];
		// 'a b c d' = 4 tokens (== target); adding 'e' would be 5 > 4, so the tiny tail stands alone.
		const spans = splitIntoSpans(nt(blocks), blocks, words, { targetTokens: 4 });
		expect(spans.map((s) => s.text)).toEqual(['a b c d', 'e']);
	});

	it('every span is a verbatim slice of normalizedText at its recorded offsets', () => {
		const blocks: Block[] = [
			{ text: 'first block', section: 'S' },
			{ text: 'second block', section: 'T' }
		];
		const text = nt(blocks);
		const spans = splitIntoSpans(text, blocks, words, { targetTokens: 100 });
		for (const s of spans) expect(text.slice(s.startOffset, s.endOffset)).toBe(s.text);
	});

	it('carries page through from the block (scanned-pdf path) and defaults section to undefined', () => {
		const blocks: Block[] = [{ text: 'page text here', page: 4 }];
		const spans = splitIntoSpans(nt(blocks), blocks, words, { targetTokens: 100 });
		expect(spans[0]?.page).toBe(4);
		expect(spans[0]?.section).toBeUndefined();
	});
});
