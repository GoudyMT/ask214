import { describe, it, expect } from 'vitest';
import { splitSentences } from './sentences';

describe('splitSentences', () => {
	it('splits on sentence-final punctuation followed by a capitalized next sentence', () => {
		const text = 'Submit the form. You have one year. Apply online.';
		const spans = splitSentences(text);
		expect(spans.map((s) => text.slice(s.start, s.end).trim())).toEqual([
			'Submit the form.',
			'You have one year.',
			'Apply online.'
		]);
	});

	it('returns one span covering the whole text when there is no internal boundary', () => {
		const text = 'A single clause with no terminal break';
		expect(splitSentences(text)).toEqual([{ start: 0, end: text.length }]);
	});

	it('tiles the input with no gap or overlap (offsets are contiguous)', () => {
		const text = 'First sentence. Second one here. Third.';
		const spans = splitSentences(text);
		expect(spans[0]?.start).toBe(0);
		expect(spans[spans.length - 1]?.end).toBe(text.length);
		for (let i = 1; i < spans.length; i++) expect(spans[i]?.start).toBe(spans[i - 1]?.end);
	});

	it('does not split inside a known abbreviation', () => {
		const text = 'You served in the U.S. Army for years. Apply now.';
		const spans = splitSentences(text);
		expect(spans.map((s) => text.slice(s.start, s.end).trim())).toEqual([
			'You served in the U.S. Army for years.',
			'Apply now.'
		]);
	});

	it('does not split when the next char is lowercase (e.g. a decimal or mid-clause period)', () => {
		const text = 'Pay within 9.5 months of separation. Done.';
		const spans = splitSentences(text);
		expect(spans.map((s) => text.slice(s.start, s.end).trim())).toEqual([
			'Pay within 9.5 months of separation.',
			'Done.'
		]);
	});

	it('handles an empty string as a single empty span', () => {
		expect(splitSentences('')).toEqual([{ start: 0, end: 0 }]);
	});
});
