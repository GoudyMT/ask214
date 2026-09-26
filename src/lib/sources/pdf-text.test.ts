import { describe, it, expect } from 'vitest';
import { joinTextItems, itemSpans, rangeToBoxes, type PdfContentItem } from './pdf-text';

/** A text item as the reader emits it: an unscaled, unrotated run at (x, baseline y) in page units. */
function text(str: string, x: number, y: number, width: number, size = 10): PdfContentItem {
	return { str, transform: [size, 0, 0, size, x, y], width, height: size };
}

/** A marked-content marker: carries no text, but still occupies a slot in the join. */
const MARKER: PdfContentItem = { type: 'beginMarkedContent' };

/** An identity viewport at scale 1 with the y axis flipped, the way a page is drawn onto a canvas. */
const PAGE_HEIGHT = 800;
const VIEWPORT = [1, 0, 0, -1, 0, PAGE_HEIGHT];

describe('joinTextItems', () => {
	// The matcher's offsets index THIS string, and the highlight gate measured the matcher against the same
	// construction. Any second way of building page text puts every highlight in the wrong place.
	it('joins text with single spaces and gives a marker an empty slot', () => {
		const items = [text('Apply', 0, 0, 25), MARKER, text('online.', 30, 0, 35)];
		expect(joinTextItems(items)).toBe('Apply  online.');
	});

	it('returns an empty string for a page with no items', () => {
		expect(joinTextItems([])).toBe('');
	});
});

describe('itemSpans', () => {
	it('locates every text item exactly where the join put it, markers and all', () => {
		const items = [
			MARKER,
			text('You', 0, 0, 15),
			text('may', 20, 0, 18),
			MARKER,
			MARKER,
			text('be', 42, 0, 10),
			text('eligible.', 56, 0, 40)
		];
		const joined = joinTextItems(items);
		const spans = itemSpans(items);
		expect(spans).toHaveLength(4);
		for (const span of spans) {
			expect(joined.slice(span.start, span.end)).toBe(span.item.str);
		}
	});
});

describe('rangeToBoxes', () => {
	it('boxes a whole item at its position, flipped into canvas coordinates', () => {
		const items = [text('Eligible', 100, 700, 50)];
		const [box] = rangeToBoxes(items, { start: 0, end: 8 }, VIEWPORT);
		expect(box).toEqual({ x: 100, y: PAGE_HEIGHT - 700 - 10, width: 50, height: 10 });
	});

	// A range can begin or end inside a run. Glyph advances are not known without the font, so the box is
	// proportional to the characters covered - close enough for a highlight band, and stated rather than
	// hidden.
	it('boxes only the covered fraction of a partly covered item', () => {
		const items = [text('abcdefghij', 0, 700, 100)];
		const [box] = rangeToBoxes(items, { start: 2, end: 7 }, VIEWPORT);
		expect(box!.x).toBeCloseTo(20);
		expect(box!.width).toBeCloseTo(50);
	});

	// Adjacent translucent boxes that overlap draw darker where they meet, which reads as stripes rather
	// than one highlight. Runs on the same line merge into a single band.
	it('merges runs on the same line into one band', () => {
		const items = [text('Apply', 0, 700, 25), text('online', 28, 700, 30)];
		const boxes = rangeToBoxes(items, { start: 0, end: 12 }, VIEWPORT);
		expect(boxes).toHaveLength(1);
		expect(boxes[0]!.x).toBe(0);
		expect(boxes[0]!.width).toBeCloseTo(58);
	});

	it('keeps separate lines as separate bands', () => {
		const items = [text('First line', 0, 700, 50), text('second line', 0, 685, 55)];
		expect(rangeToBoxes(items, { start: 0, end: 22 }, VIEWPORT)).toHaveLength(2);
	});

	it('does not merge runs on one line that are far apart', () => {
		const items = [text('Left', 0, 700, 20), text('column', 300, 700, 30)];
		expect(rangeToBoxes(items, { start: 0, end: 11 }, VIEWPORT)).toHaveLength(2);
	});

	it('returns no boxes for a range that covers no text', () => {
		const items = [text('Eligible', 0, 700, 50)];
		expect(rangeToBoxes(items, { start: 40, end: 60 }, VIEWPORT)).toEqual([]);
	});

	it('scales boxes with the viewport', () => {
		const items = [text('Eligible', 100, 700, 50)];
		const [box] = rangeToBoxes(items, { start: 0, end: 8 }, [2, 0, 0, -2, 0, PAGE_HEIGHT * 2]);
		expect(box).toEqual({ x: 200, y: (PAGE_HEIGHT - 700 - 10) * 2, width: 100, height: 20 });
	});
});
