/**
 * Which page of a scrolled stack of pages the reader is on: the last page whose top has reached a reading line
 * a third of the way down the view.
 *
 * A third, not the top edge: a page counts as the one being read once its top has come well into view, so the
 * number turns as the reader moves onto a page rather than only once the page fills the view - and a short
 * page scrolled past its top still owns the number until the next one arrives.
 *
 * Args:
 *   pageTops: each page's top, in order, in the scrolled content's own coordinates (as `scrollTop` counts)
 *   scrollTop: how far the view is scrolled
 *   viewHeight: the height of the scrolling view
 *
 * Returns:
 *   The 1-based page in view; 1 before any page is laid out.
 */
export function pageInView(
	pageTops: readonly number[],
	scrollTop: number,
	viewHeight: number
): number {
	const line = scrollTop + viewHeight / 3;
	let page = 1;
	pageTops.forEach((top, index) => {
		if (top <= line) page = index + 1;
	});
	return page;
}

/**
 * The nearest ancestor the reader can scroll vertically - the view a stack of pages is measured and drawn
 * against. A box that only clips (`overflow-y: hidden`) cannot be scrolled by the reader, so it is passed over.
 *
 * Args:
 *   node: the element whose scrolling view is wanted
 *
 * Returns:
 *   That ancestor, or null when none scrolls.
 */
export function scrollParent(node: Element): HTMLElement | null {
	for (let el = node.parentElement; el !== null; el = el.parentElement) {
		const overflowY = getComputedStyle(el).overflowY;
		if (overflowY === 'auto' || overflowY === 'scroll') return el;
	}
	return null;
}
