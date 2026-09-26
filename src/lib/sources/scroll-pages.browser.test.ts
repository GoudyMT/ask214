import { afterEach, describe, it, expect } from 'vitest';
import { pageInView, scrollParent } from './scroll-pages';

// Page tops in the scrolled content's own coordinates, as a stack of pages of UNEQUAL heights lays them out
// (a cover, a landscape table page, body pages): dividing the scroll by one page height gets these wrong.
const TOPS = [0, 400, 650, 1200, 1750];

describe('pageInView', () => {
	it('is the first page at the top of the document', () => {
		expect(pageInView(TOPS, 0, 600)).toBe(1);
	});

	// The reading line sits a third of the way down the view: scrolled 200 into a 600 view, it is at 400.
	it('counts a page whose top is exactly on the reading line', () => {
		expect(pageInView(TOPS, 200, 600)).toBe(2);
		expect(pageInView(TOPS, 199, 600)).toBe(1);
	});

	// Several page tops have passed the line: the one in view is the LAST of them, not the first.
	it('is the last page whose top has passed the reading line', () => {
		expect(pageInView(TOPS, 1000, 600)).toBe(4);
	});

	it('is the last page at the end of the document', () => {
		expect(pageInView(TOPS, 1900, 600)).toBe(5);
	});

	it('is page 1 before any page has been laid out', () => {
		expect(pageInView([], 500, 600)).toBe(1);
	});
});

describe('scrollParent', () => {
	const made: HTMLElement[] = [];
	afterEach(() => {
		for (const el of made.splice(0)) el.remove();
	});

	function box(overflowY: string, parent: HTMLElement = document.body): HTMLElement {
		const el = document.createElement('div');
		el.style.overflowY = overflowY;
		parent.appendChild(el);
		if (parent === document.body) made.push(el);
		return el;
	}

	it('is the nearest ancestor that scrolls vertically, not a farther one', () => {
		const outer = box('auto');
		const middle = box('scroll', outer);
		const inner = box('visible', middle);
		const node = box('visible', inner);
		expect(scrollParent(node)).toBe(middle);
	});

	// A clipped box cannot be scrolled by the reader, so it is passed over.
	it('passes over an ancestor that only clips', () => {
		const outer = box('auto');
		const clip = box('hidden', outer);
		const node = box('visible', clip);
		expect(scrollParent(node)).toBe(outer);
	});

	it('is null when no ancestor scrolls', () => {
		const plain = box('visible');
		const node = box('visible', plain);
		expect(scrollParent(node)).toBeNull();
	});
});
