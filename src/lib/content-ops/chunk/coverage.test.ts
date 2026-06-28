import { describe, it, expect } from 'vitest';
import { checkCoverage } from './coverage';
import type { ChunkSpan } from './split';

function span(text: string, startOffset: number): ChunkSpan {
	return { text, startOffset, endOffset: startOffset + text.length, brokeAtTokenLevel: false };
}

describe('checkCoverage', () => {
	it('passes when spans tile the text with only single-space gaps between them', () => {
		const nt = 'alpha beta gamma';
		const spans = [span('alpha', 0), span('beta', 6), span('gamma', 11)];
		expect(checkCoverage(spans, nt)).toEqual({ ok: true });
	});

	it('fails when a non-whitespace run is dropped between two spans', () => {
		const nt = 'alpha BETA gamma';
		const spans = [span('alpha', 0), span('gamma', 11)];
		const r = checkCoverage(spans, nt);
		expect(r.ok).toBe(false);
	});

	it('fails on a non-whitespace prefix before the first span', () => {
		const nt = 'X alpha';
		expect(checkCoverage([span('alpha', 2)], nt).ok).toBe(false);
	});

	it('fails on a non-whitespace tail after the last span', () => {
		const nt = 'alpha Y';
		expect(checkCoverage([span('alpha', 0)], nt).ok).toBe(false);
	});

	it('fails on overlapping spans', () => {
		const nt = 'alpha beta';
		const spans = [
			span('alpha', 0),
			{ text: 'pha beta', startOffset: 2, endOffset: 10, brokeAtTokenLevel: false }
		];
		expect(checkCoverage(spans, nt).ok).toBe(false);
	});

	it('passes on the empty / all-whitespace case', () => {
		expect(checkCoverage([], '   ')).toEqual({ ok: true });
	});
});
