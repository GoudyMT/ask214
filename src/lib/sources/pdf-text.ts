/**
 * The PDF reader's text items, and how to turn a character range in them into boxes on a rendered page.
 *
 * The item types are declared structurally instead of imported from the PDF library, because nothing in
 * `src/` may import that library statically: it is reachable only behind a dynamic import, so that a
 * passive visit never loads it. A type import would still trip that rule's check.
 */

/** The part of a reader text item this module reads. `transform` is the run's affine matrix in page units. */
export type PdfTextItem = { str: string; transform: number[]; width: number; height: number };

/** A reader content item: either a text run, or a marked-content marker that carries no text. */
export type PdfContentItem = PdfTextItem | { type: string };

/** A rectangle on the rendered page, in canvas pixels, origin top-left. */
export type Box = { x: number; y: number; width: number; height: number };

/** Where one text item sits inside the page text built by `joinTextItems`. */
export type ItemSpan = { item: PdfTextItem; start: number; end: number };

/**
 * How close two runs on one line must be to merge into one band, as a fraction of the line height.
 * Wide enough to bridge the space between words, narrow enough that two columns never fuse.
 */
const MERGE_GAP = 0.5;

/** Runs whose baselines differ by less than this fraction of the line height sit on the same line. */
const SAME_LINE = 0.5;

export function isTextItem(item: PdfContentItem): item is PdfTextItem {
	return 'str' in item;
}

/**
 * Build a page's text from its items. This is the ONLY construction of page text anywhere in the app.
 *
 * The highlight matcher returns offsets into the string this produces, and the highlight gate measures
 * the matcher against the same string. A second construction that differed by as much as one separator
 * would put every highlight in the wrong place with nothing failing - which is exactly how a normalized
 * copy once shifted every range by the whitespace it had collapsed.
 *
 * A marker contributes an empty slot rather than being dropped, so the separators around it are kept.
 *
 * @param items The page's content items, in reader order.
 * @returns The page text, runs joined by single spaces.
 */
export function joinTextItems(items: readonly PdfContentItem[]): string {
	return items.map((item) => (isTextItem(item) ? item.str : '')).join(' ');
}

/**
 * Locate each text item inside `joinTextItems`' output. Walks the same sequence of slots and separators,
 * so the two can only agree.
 *
 * @param items The page's content items, in reader order.
 * @returns One span per text item; markers produce none.
 */
export function itemSpans(items: readonly PdfContentItem[]): ItemSpan[] {
	const spans: ItemSpan[] = [];
	let offset = 0;
	items.forEach((item, index) => {
		if (index > 0) offset += 1;
		if (!isTextItem(item)) return;
		spans.push({ item, start: offset, end: offset + item.str.length });
		offset += item.str.length;
	});
	return spans;
}

/** Compose two affine matrices [a, b, c, d, e, f], applying `inner` first and `outer` second. */
function compose(outer: readonly number[], inner: readonly number[]): number[] {
	const [a1 = 0, b1 = 0, c1 = 0, d1 = 0, e1 = 0, f1 = 0] = outer;
	const [a2 = 0, b2 = 0, c2 = 0, d2 = 0, e2 = 0, f2 = 0] = inner;
	return [
		a1 * a2 + c1 * b2,
		b1 * a2 + d1 * b2,
		a1 * c2 + c1 * d2,
		b1 * c2 + d1 * d2,
		a1 * e2 + c1 * f2 + e1,
		b1 * e2 + d1 * f2 + f1
	];
}

/** Join boxes that sit on the same line and touch, so translucent fills never overlap into stripes. */
function mergeLines(boxes: Box[]): Box[] {
	const sorted = [...boxes].sort((p, q) => p.y - q.y || p.x - q.x);
	const merged: Box[] = [];
	for (const box of sorted) {
		const last = merged[merged.length - 1];
		const sameLine = last !== undefined && Math.abs(last.y - box.y) < SAME_LINE * last.height;
		if (last !== undefined && sameLine && box.x <= last.x + last.width + MERGE_GAP * last.height) {
			const right = Math.max(last.x + last.width, box.x + box.width);
			const top = Math.min(last.y, box.y);
			const bottom = Math.max(last.y + last.height, box.y + box.height);
			last.x = Math.min(last.x, box.x);
			last.width = right - last.x;
			last.y = top;
			last.height = bottom - top;
		} else {
			merged.push({ ...box });
		}
	}
	return merged;
}

/**
 * Turn a character range of the page text into boxes on the rendered page.
 *
 * A run's position comes from composing the viewport's transform with the run's own, the same geometry
 * the reader uses to draw it. A range that begins or ends inside a run is boxed in proportion to the
 * characters it covers: glyph advances are unknown without the font, so this is an approximation, exact
 * for a whole run and close for a partial one - which is all a highlight band needs.
 *
 * Runs are assumed horizontal. Rotated text would need a rotated box, and none of the served documents
 * set text at an angle.
 *
 * @param items The page's content items, in reader order.
 * @param range A range of `joinTextItems(items)`.
 * @param viewport The viewport's transform - the same one the page was rendered with.
 * @returns Boxes in canvas pixels, one per line segment the range covers.
 */
export function rangeToBoxes(
	items: readonly PdfContentItem[],
	range: { start: number; end: number },
	viewport: readonly number[]
): Box[] {
	const scale = Math.hypot(viewport[0] ?? 0, viewport[1] ?? 0);
	const boxes: Box[] = [];
	for (const span of itemSpans(items)) {
		const from = Math.max(span.start, range.start);
		const to = Math.min(span.end, range.end);
		if (from >= to) continue;

		const length = span.end - span.start;
		const tx = compose(viewport, span.item.transform);
		const lineHeight = Math.hypot(tx[2] ?? 0, tx[3] ?? 0);
		const runWidth = span.item.width * scale;
		const left = (tx[4] ?? 0) + (runWidth * (from - span.start)) / length;
		const width = (runWidth * (to - from)) / length;
		boxes.push({ x: left, y: (tx[5] ?? 0) - lineHeight, width, height: lineHeight });
	}
	return mergeLines(boxes);
}
