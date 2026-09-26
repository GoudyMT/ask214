/** A highlight range inside one page's own text. */
export type PageRange = { page: number; start: number; end: number };

/** Where a stored anchor was found in a document, split by the pages it covers. */
export type AnchorMatch = { ranges: PageRange[]; coverage: number };

/** A range inside a single string, with how much of the anchor it accounts for. */
export type TextMatch = { start: number; end: number; coverage: number };

/**
 * A located highlight must account for at least this much of the anchor. Below it the band is too small
 * to be the passage the citation promised, and showing it would point the reader at the wrong sentence.
 */
const MIN_COVERAGE = 0.6;

/**
 * Characters of unrelated text tolerated between two parts of the same passage. A passage that crosses a
 * page boundary is interrupted by the first page's footer and the second page's header, which is bounded
 * furniture rather than missing text. Larger values let the walk stitch unrelated text into a match.
 */
const MAX_GAP = 400;

/** Length of the fragment used to re-acquire the passage on the far side of an interruption. */
const REACQUIRE = 40;

/**
 * Offsets into the anchor to try when seeking its longest present run, as fractions of its length. The
 * first covers the ordinary case; the rest survive an opening that is damaged or sits elsewhere in the
 * document, which is what a running header at the start of a chunk does.
 */
const SEEK_FROM = [0, 0.1, 0.2, 0.35, 0.5];

/** Pages searched around the cited one, widest last. The citation decides before the neighbourhood does. */
const WINDOWS = [
	{ before: 0, after: 0 },
	{ before: 0, after: 1 },
	{ before: 1, after: 2 }
];

type Folded = { folded: string; map: number[] };

/**
 * Reduce text to lowercase alphanumerics, keeping an index from each folded character back to the source.
 *
 * Everything a PDF text layer disagrees about disappears here: inserted spaces, split words, soft hyphens,
 * punctuation spacing. The fold can be this aggressive because its only job is to LOCATE a position - the
 * highlight is painted in the source's own coordinates, via the map.
 *
 * It folds the RAW string deliberately, and does NOT run the corpus normalizer first. Normalising would
 * collapse whitespace runs, which shortens the string and leaves every offset pointing several characters
 * earlier than the caller's own text - a highlight that starts mid-word and drifts further the more
 * whitespace precedes the passage. Nothing is lost by skipping it: the normalizer's whitespace collapse,
 * zero-width stripping and de-hyphenation are all subsumed by keeping only alphanumerics, and its ligature
 * expansion is covered by decomposing each character below.
 */
function fold(source: string): Folded {
	let folded = '';
	const map: number[] = [];
	for (let i = 0; i < source.length; i += 1) {
		const code = source.charCodeAt(i);
		// Fast path for ASCII, which is nearly all of it; decomposing every character would be far slower.
		if (code < 128) {
			if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
				folded += source[i];
				map.push(i);
			} else if (code >= 65 && code <= 90) {
				folded += String.fromCharCode(code + 32);
				map.push(i);
			}
			continue;
		}
		// Compatibility decomposition turns a ligature into its letters and an accented letter into a
		// plain one plus a combining mark, which is not alphanumeric and so drops out. Every character it
		// yields maps back to this one source index, so a ligature highlights as the single glyph it is.
		for (const ch of (source[i] as string).normalize('NFKD').toLowerCase()) {
			if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
				folded += ch;
				map.push(i);
			}
		}
	}
	return { folded, map };
}

/** The longest prefix of `needle` from `start` that occurs in `hay`, by binary search on length. */
function longestRunFrom(
	hay: string,
	needle: string,
	start: number
): { at: number; length: number } {
	let lo = 0;
	let hi = needle.length - start;
	let bestAt = -1;
	let best = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (mid === 0) break;
		const at = hay.indexOf(needle.substr(start, mid));
		if (at >= 0) {
			best = mid;
			bestAt = at;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return { at: bestAt, length: best };
}

/** The longest run of `needle` from `from` that sits at exactly `at` in `hay`. */
function matchLengthAt(hay: string, at: number, needle: string, from: number): number {
	let lo = 0;
	let hi = Math.min(needle.length - from, hay.length - at);
	let best = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (mid === 0) break;
		if (hay.startsWith(needle.substr(from, mid), at)) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return best;
}

/** Grow a run forwards and backwards past bounded interruptions, reporting how much it accounts for. */
function extend(
	hay: string,
	needle: string,
	run: { at: number; length: number; start: number }
): { start: number; end: number; covered: number } {
	let covered = run.length;
	let needleEnd = run.start + run.length;
	let hayEnd = run.at + run.length;
	while (needleEnd < needle.length) {
		const fragment = needle.substr(needleEnd, REACQUIRE);
		if (fragment.length < 12) break;
		const at = hay.indexOf(fragment, hayEnd);
		if (at < 0 || at - hayEnd > MAX_GAP) break;
		const length = matchLengthAt(hay, at, needle, needleEnd);
		if (length < 12) break;
		covered += length;
		needleEnd += length;
		hayEnd = at + length;
	}
	let needleStart = run.start;
	let hayStart = run.at;
	while (needleStart > 0) {
		const take = Math.min(REACQUIRE, needleStart);
		if (take < 12) break;
		const fragment = needle.substr(needleStart - take, take);
		const at = hay.lastIndexOf(fragment, hayStart - take);
		if (at < 0 || hayStart - (at + take) > MAX_GAP) break;
		covered += take;
		needleStart -= take;
		hayStart = at;
	}
	return { start: hayStart, end: hayEnd, covered };
}

/**
 * Locate a stored anchor inside one block of text.
 *
 * The anchor is the chunk's own text, which on this corpus is close to a full page, so it is rarely
 * contiguous in a reader's output. The search therefore anchors on the anchor's longest PRESENT run
 * rather than its opening, then grows that run past bounded interruptions.
 *
 * The range spans matched CONTENT, so it begins at the passage's first letter or digit and ends just
 * after its last. Punctuation on either edge falls outside it, which is what a highlight should do anyway.
 *
 * @param text The text to search, as the reader produced it.
 * @param anchor The stored passage.
 * @returns The range in `text`, with the fraction of the anchor it accounts for, or null below the bar.
 */
export function findAnchor(text: string, anchor: string): TextMatch | null {
	const hay = fold(text);
	const needle = fold(anchor);

	// No guard for an empty text or anchor: neither holds a run, so the search below finds none and returns
	// null, and an empty anchor ends the loop at once, as the whole of it is trivially "found".
	let best = { at: -1, length: 0, start: 0 };
	for (const fraction of SEEK_FROM) {
		const from = Math.floor(needle.folded.length * fraction);
		const run = longestRunFrom(hay.folded, needle.folded, from);
		if (run.length > best.length) best = { ...run, start: from };
		if (best.length === needle.folded.length) break;
	}
	if (best.at < 0) return null;

	const grown = extend(hay.folded, needle.folded, best);
	const coverage = grown.covered / needle.folded.length;
	if (coverage < MIN_COVERAGE) return null;

	// Both fall inside the map: it holds one entry per folded character, and a match lies within those.
	const start = hay.map[grown.start] as number;
	const end = hay.map[grown.end - 1] as number;
	return { start, end: end + 1, coverage };
}

/**
 * The pages `findAnchorInDocument` may read for a citation, derived from the same windows it searches.
 *
 * A caller that fetches page text lazily must fetch exactly these. Keeping its own copy of the window
 * would be safe only until the search widened; after that it would hand the search blank pages and the
 * highlights would fade out with nothing failing.
 *
 * @param citedPage The 1-based page the citation names.
 * @param pageCount The number of pages in the document.
 * @returns The 1-based page numbers, ascending; empty when the cited page is outside the document.
 */
export function searchPages(citedPage: number, pageCount: number): number[] {
	if (!Number.isInteger(citedPage) || citedPage < 1 || citedPage > pageCount) return [];
	const before = Math.max(...WINDOWS.map((w) => w.before));
	const after = Math.max(...WINDOWS.map((w) => w.after));
	const pages: number[] = [];
	for (
		let n = Math.max(1, citedPage - before);
		n <= Math.min(pageCount, citedPage + after);
		n += 1
	) {
		pages.push(n);
	}
	return pages;
}

/**
 * Locate a stored anchor in a document, preferring the page the citation names.
 *
 * The cited page is searched ALONE first, and the window widens only when that fails. Without this a
 * passage repeated across the document - boilerplate notices, contact blocks - matches whichever instance
 * the search reaches first, and the reader opens at the cited page with the highlight somewhere else.
 *
 * @param pages Each page's text in document order, as the reader produced it.
 * @param citedPage The 1-based page the citation names.
 * @param anchor The stored passage.
 * @returns Ranges in each covered page's own coordinates, or null when nothing clears the bar.
 */
export function findAnchorInDocument(
	pages: readonly string[],
	citedPage: number,
	anchor: string
): AnchorMatch | null {
	// No page count check of its own: with no pages, every cited page fails the range check below.
	if (!Number.isInteger(citedPage)) return null;
	if (citedPage < 1 || citedPage > pages.length) return null;

	for (const window of WINDOWS) {
		const first = Math.max(1, citedPage - window.before);
		const last = Math.min(pages.length, citedPage + window.after);

		// Join with a space so the fold cannot fuse the last word of one page to the first of the next,
		// and record where each page sits so a match can be split back into per-page ranges.
		const bounds: { page: number; start: number; end: number }[] = [];
		let text = '';
		for (let n = first; n <= last; n += 1) {
			const body = pages[n - 1] ?? '';
			if (text.length > 0) text += ' ';
			bounds.push({ page: n, start: text.length, end: text.length + body.length });
			text += body;
		}

		const found = findAnchor(text, anchor);
		if (found === null) continue;

		const ranges: PageRange[] = [];
		for (const bound of bounds) {
			const start = Math.max(found.start, bound.start);
			const end = Math.min(found.end, bound.end);
			if (start >= end) continue;
			ranges.push({ page: bound.page, start: start - bound.start, end: end - bound.start });
		}
		if (ranges.length === 0) continue;
		return { ranges, coverage: found.coverage };
	}
	return null;
}
