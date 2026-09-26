import { describe, it, expect } from 'vitest';
import { findAnchor, findAnchorInDocument, searchPages } from './highlight-match';

/** The text a page yields, as the reader joins its positioned items. */
function page(...parts: string[]): string {
	return parts.join(' ');
}

describe('findAnchor', () => {
	it('locates a contiguous passage and returns its range in the source text', () => {
		const text = 'Before it. You may be eligible for VA health care. After it.';
		const found = findAnchor(text, 'You may be eligible for VA health care.');
		expect(found).not.toBeNull();
		expect(text.slice(found!.start, found!.end)).toBe('You may be eligible for VA health care');
	});

	// The largest failure class by far: the reader emits positioned items, so joining them inserts spaces
	// the document never had and keeps soft hyphens the cleaner removed. A word-token matcher scores half
	// what this one does on the real corpus, entirely because of this.
	it('resolves through reader tokenization damage', () => {
		const text = 'Apply online at the Track : portal semi- annually and W ere done.';
		const found = findAnchor(text, 'Apply online at the Track: portal semiannually and Were done.');
		expect(found).not.toBeNull();
		expect(found!.coverage).toBeGreaterThan(0.95);
	});

	// A chunk that opens with the page's running header cannot match contiguously, because the header
	// sits elsewhere in the reader's output. Highlighting the body without the header is correct - the
	// header is not the passage.
	it('anchors on the passage when the anchor opens with a relocated running header', () => {
		const text = page(
			'The benefit is paid monthly to every qualifying veteran who applies in time.',
			'GUIDE | SECTION 1 | PAGE 10'
		);
		const found = findAnchor(
			text,
			'GUIDE | SECTION 1 | PAGE 10 The benefit is paid monthly to every qualifying veteran who applies in time.'
		);
		expect(found).not.toBeNull();
		expect(text.slice(found!.start, found!.end)).toContain('paid monthly');
	});

	// Before extension, page-crossing passages clustered at almost exactly half coverage - the signature
	// of a footer plus a header wedged between the two halves.
	it('extends across page furniture wedged into the middle of a passage', () => {
		const text = page(
			'The first half of the claim explains what to send and when to send it.',
			'GUIDE PAGE 11 GUIDE PAGE 12',
			'The second half explains who decides it and how long that takes.'
		);
		const anchor =
			'The first half of the claim explains what to send and when to send it. The second half explains who decides it and how long that takes.';
		const found = findAnchor(text, anchor);
		expect(found).not.toBeNull();
		expect(found!.coverage).toBeGreaterThan(0.95);
	});

	it('returns null rather than a wrong span when the passage is absent', () => {
		expect(
			findAnchor('Nothing relevant here at all.', 'You may be eligible for VA care')
		).toBeNull();
	});

	// Without a bound, an in-order walk stitches scattered common words into a match that is not the
	// passage. The filler here is far longer than the tolerated interruption.
	it('does not leap across an unbounded gap', () => {
		const text = page('You may be eligible', 'filler '.repeat(200), 'for VA health care.');
		expect(findAnchor(text, 'You may be eligible for VA health care.')).toBeNull();
	});

	it('normalizes both sides so a ligature still resolves', () => {
		const text = 'The bene' + String.fromCharCode(0xfb01) + 't is available to you now.';
		expect(findAnchor(text, 'The benefit is available to you now.')).not.toBeNull();
	});

	it('returns null for an empty anchor rather than matching everything', () => {
		expect(findAnchor('Any text at all.', '')).toBeNull();
		expect(findAnchor('Any text at all.', '   ')).toBeNull();
	});

	it('returns null for empty source text', () => {
		expect(findAnchor('', 'You may be eligible')).toBeNull();
	});

	// The caller slices the text it PASSED IN, so the range has to be in that string's coordinates. A
	// reader's output is full of collapsible whitespace, and any normalisation applied before the search
	// shortens the string - so an offset taken from normalised text lands several characters early and
	// drifts further the more whitespace precedes the passage. A single-spaced fixture cannot see this.
	it('returns offsets into the text it was given, not into a normalized copy', () => {
		const anchor = 'The notice explains who may apply.';
		const text = `Lead${'   \n\n   '}in here.   ${anchor} Trailing.`;
		const found = findAnchor(text, anchor);
		expect(found).not.toBeNull();
		// Exact, not loosened: the range must begin where the passage begins, and cover it through its
		// last letter. Trailing punctuation sits outside a content range by design.
		expect(found!.start).toBe(text.indexOf(anchor));
		expect(text.slice(found!.start, found!.end)).toBe(anchor.replace(/[^A-Za-z0-9]+$/, ''));
	});

	it('keeps offsets aligned when the text contains a ligature', () => {
		const anchor = 'The benefit is available.';
		const text = `Lead in.   The bene${String.fromCharCode(0xfb01)}t is available. Trailing.`;
		const found = findAnchor(text, anchor);
		expect(found).not.toBeNull();
		expect(text.slice(found!.start, found!.end)).toContain('t is available');
		expect(text.slice(found!.start, found!.end).startsWith('The bene')).toBe(true);
	});
});

describe('findAnchorInDocument', () => {
	const NOTICE = 'This notice explains who may apply and what evidence is required.';

	it('returns ranges on the cited page for a passage that sits there', () => {
		const pages = ['Page one text.', NOTICE, 'Page three text.'];
		const match = findAnchorInDocument(pages, 2, NOTICE);
		expect(match).not.toBeNull();
		expect(match!.ranges.map((r) => r.page)).toEqual([2]);
	});

	// Measured: 7.6% of located highlights landed on a page the citation did not name, because repeated
	// boilerplate matched a different instance at full coverage. The citation decides which one wins.
	it('prefers the cited page over an identical passage on an adjacent one', () => {
		// The duplicate must sit INSIDE the widest search window, or the assertion passes on an
		// implementation that never prefers the cited page at all: a window that excludes the wrong
		// instance cannot choose it. Here pages 2 and 3 are identical and both fall in the widest window
		// from page 3, so a search that widens first lands on page 2 and fails this.
		const pages = ['Intro.', NOTICE, NOTICE];
		expect(findAnchorInDocument(pages, 3, NOTICE)!.ranges[0]!.page).toBe(3);
		expect(findAnchorInDocument(pages, 2, NOTICE)!.ranges[0]!.page).toBe(2);
	});

	// A chunk is nearly page-sized on this corpus, so it routinely starts on its cited page and finishes
	// on the next. The highlight has to follow it.
	it('follows a passage that spills onto the next page', () => {
		const pages = [
			'Intro.',
			'The first half of the claim explains what to send and when to send it.',
			'The second half explains who decides it and how long that takes.'
		];
		const anchor =
			'The first half of the claim explains what to send and when to send it. The second half explains who decides it and how long that takes.';
		const match = findAnchorInDocument(pages, 2, anchor);
		expect(match).not.toBeNull();
		expect(match!.ranges.map((r) => r.page)).toEqual([2, 3]);
	});

	// Each range must be usable directly as an offset into that page's own text, because the viewer
	// renders one page at a time and knows nothing about the window the match was found in.
	it('returns ranges in the coordinates of the page they fall on', () => {
		const pages = ['Intro.', `Lead in. ${NOTICE} Trailing.`];
		const match = findAnchorInDocument(pages, 2, NOTICE);
		const range = match!.ranges[0]!;
		expect(pages[1]!.slice(range.start, range.end)).toContain('who may apply');
	});

	// Same coordinate requirement, one level up: the viewer slices the page text the reader produced, so a
	// page carrying collapsible whitespace must still yield a range that indexes THAT string.
	it('returns per-page ranges that index the raw page text, whitespace and all', () => {
		const pages = ['Intro.', `Lead${'  \n  '}in.   ${NOTICE}   Trailing.`];
		const match = findAnchorInDocument(pages, 2, NOTICE);
		expect(match).not.toBeNull();
		const range = match!.ranges[0]!;
		expect(range.start).toBe(pages[1]!.indexOf(NOTICE));
		expect(pages[1]!.slice(range.start, range.end)).toBe(NOTICE.replace(/[^A-Za-z0-9]+$/, ''));
	});

	it('returns null when the passage is nowhere in the document', () => {
		expect(findAnchorInDocument(['One.', 'Two.'], 1, 'Entirely absent passage here')).toBeNull();
	});

	it('does not throw on a cited page outside the document', () => {
		expect(findAnchorInDocument(['One.'], 99, NOTICE)).toBeNull();
		expect(findAnchorInDocument([], 1, NOTICE)).toBeNull();
	});

	// The extension measured 1.27 pages per highlight against a 1.2 bar, so the window is deliberately
	// bounded: a passage may spill forward, never sprawl across the document.
	it('never spans more pages than the search window allows', () => {
		const pages = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((c) => `${c} `.repeat(40));
		const match = findAnchorInDocument(pages, 3, 'zzz nowhere');
		expect(match).toBeNull();
	});
});

// A caller that loads pages lazily must fetch exactly what the search may read. If it kept its own copy of
// the window and the search later widened, it would hand the search blank pages and highlights would fade
// out with nothing failing - so the search owns the list.
describe('searchPages', () => {
	it('names every page the search may read, clamped to the document', () => {
		expect(searchPages(5, 20)).toEqual([4, 5, 6, 7]);
		expect(searchPages(1, 20)).toEqual([1, 2, 3]);
		expect(searchPages(20, 20)).toEqual([19, 20]);
	});

	it('is exactly sufficient: blanking every other page changes no result', () => {
		// The passage sits at the FAR edge of the widest window - split across the second and third pages
		// after the cited one - so a list that stopped even one page short would blank half of it and change
		// the result. A passage on the cited page alone would pass against a list of just that page.
		const pages = Array.from({ length: 9 }, (_, i) => `Page ${i + 1} body text that is unrelated.`);
		const first = 'The first half of the claim explains what to send and when to send it.';
		const second = 'The second half explains who decides it and how long that takes.';
		const anchor = `${first} ${second}`;
		pages[5] = first;
		pages[6] = second;
		const onlyWindow = pages.map((body, i) => (searchPages(5, 9).includes(i + 1) ? body : ''));
		expect(findAnchorInDocument(onlyWindow, 5, anchor)).toEqual(
			findAnchorInDocument(pages, 5, anchor)
		);
	});

	it('returns nothing for a cited page outside the document', () => {
		expect(searchPages(0, 5)).toEqual([]);
		expect(searchPages(9, 5)).toEqual([]);
	});
});
