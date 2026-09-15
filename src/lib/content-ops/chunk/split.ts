import type { Block } from '../extract/pdf-text';
import { splitSentences } from './sentences';

export type ChunkSpan = {
	text: string;
	startOffset: number;
	endOffset: number;
	page?: number;
	section?: string;
	brokeAtTokenLevel: boolean;
};

type CountTokens = (text: string) => number;
type SplitOpts = { targetTokens?: number };
type Unit = {
	start: number;
	end: number;
	page?: number;
	section?: string;
	brokeAtTokenLevel: boolean;
};

const DEFAULT_TARGET = 256;

// List-marker glyphs this corpus uses as bullets and separators: bullet, black and white square, diamond,
// circles, small square, bullet operator, the right guillemet used as a breadcrumb separator, the minus
// sign (which this corpus uses only as a separator, never as a math minus), and the dingbat
// negative-circled digits used as ordered-list bullets.
//
// They matter here because extraction flattens a bullet list into one run carrying no sentence terminator,
// so splitSentences returns a whole list as a single unit and the only remaining cut is a token window
// landing mid-item. A marker is the item boundary that prevents that.
//
// clean-excerpt.ts carries the same glyph set for DISPLAY. The two are deliberately kept separate: a
// readability tweak there must never silently re-cut the corpus, and a boundary change here must go
// through the retrieval eval. Built from code points so this file stays pure ASCII.
const MARKER_CODE_POINTS = [
	0x2022, 0x25a0, 0x25a1, 0x2666, 0x25cb, 0x25aa, 0x25cf, 0x2219, 0x00bb, 0x2212
];
const MARKER_RANGE_START = 0x2776;
const MARKER_RANGE_END = 0x277f;
const MARKER_RUN_SOURCE =
	'\\s*[' +
	MARKER_CODE_POINTS.map((p) => String.fromCharCode(p)).join('') +
	String.fromCharCode(MARKER_RANGE_START) +
	'-' +
	String.fromCharCode(MARKER_RANGE_END) +
	']+\\s*';

function carry(u: Unit, start: number, end: number, broke: boolean): Unit {
	const out: Unit = { start, end, brokeAtTokenLevel: broke };
	if (u.page !== undefined) out.page = u.page;
	if (u.section !== undefined) out.section = u.section;
	return out;
}

function mapBlockOffsets(normalizedText: string, blocks: Block[]): Unit[] {
	const units: Unit[] = [];
	let cursor = 0;
	for (const b of blocks) {
		const idx = normalizedText.indexOf(b.text, cursor);
		if (idx === -1) throw new Error('E_CHUNK_BLOCK_NOT_LOCATED');
		const u: Unit = { start: idx, end: idx + b.text.length, brokeAtTokenLevel: false };
		if (b.page !== undefined) u.page = b.page;
		if (b.section !== undefined) u.section = b.section;
		units.push(u);
		cursor = idx + b.text.length;
	}
	return units;
}

/**
 * Split `text` into contiguous, tiling spans at list-marker boundaries (offsets into `text`). A boundary
 * opens at each marker run past the first character, so every span carries its own leading marker and a
 * marker is never orphaned onto the end of the previous span. Spans tile `[0, len)` so a caller can pack
 * them without dropping characters; text holding no marker returns as one whole span. Pure, ASCII-only.
 */
function splitParagraphs(text: string): Array<{ start: number; end: number }> {
	const bounds: number[] = [0];
	const re = new RegExp(MARKER_RUN_SOURCE, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > 0) bounds.push(m.index);
	}
	bounds.push(text.length);

	const spans: Array<{ start: number; end: number }> = [];
	for (let i = 0; i < bounds.length - 1; i++) {
		const start = bounds[i] ?? 0;
		const end = bounds[i + 1] ?? text.length;
		if (end > start) spans.push({ start, end });
	}
	return spans;
}

// A single sentence over the target: pack its words into <=target windows at word boundaries (last resort).
function tokenWindows(
	nt: string,
	u: Unit,
	target: number,
	countTokens: CountTokens,
	out: Unit[]
): void {
	const re = /\S+/g;
	const text = nt.slice(u.start, u.end);
	const ends: number[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) ends.push(u.start + m.index + m[0].length);

	let winStart = u.start;
	let lastFit = u.start;
	for (const e of ends) {
		if (countTokens(nt.slice(winStart, e)) <= target) {
			lastFit = e;
			continue;
		}
		if (lastFit > winStart) {
			out.push(carry(u, winStart, lastFit, true));
			winStart = lastFit;
		}
		// the word itself may still exceed target from winStart; force it so we always make progress.
		if (countTokens(nt.slice(winStart, e)) > target) {
			out.push(carry(u, winStart, e, true));
			winStart = e;
		}
		lastFit = e;
	}
	if (winStart < u.end) out.push(carry(u, winStart, u.end, true));
}

// A unit that RESOLVES the one before it, and a unit that LEAVES ITS CLAUSE OPEN. Either way the pair
// carries one meaning and a boundary between them changes what the text says.
//
// The first form is an answer key: a claim followed by the verdict that corrects it. This corpus
// deliberately contains claims that are wrong - a guide states them so a reader can judge them - so a
// chunk holding the claim without its verdict renders a falsehood in the document's own voice.
//
// The second is a governing condition severed from its consequence. Measured on a benefits page: one
// chunk ended "...under the Camp Lejeune Justice Act of 2022, and" while the next opened on the remaining
// condition followed by "The court must reduce the award", so the answer asserted an unconditional legal
// consequence whose qualifying clause had been cut away. Text true in the source and false on screen is
// the one shape 38 CFR 14.629 forbids.
const RESOLVES_PREVIOUS_RE = /^(?:TRUE|FALSE)\s*:/i;
const LEAVES_CLAUSE_OPEN_RE = /(?:,\s*(?:and|or)|:)$/i;

/**
 * Join adjacent units whose boundary would orphan one from the other, so packing cannot place them in
 * different chunks. Runs after `explode` and before packing, because packing treats a unit as atomic -
 * making the pair one unit is what guarantees they travel together, rather than asking the packer to
 * avoid a boundary it may have no room to avoid.
 *
 * Only joins within a section, and only forward, so the result still tiles in order.
 */
function joinUnresolved(nt: string, units: Unit[]): Unit[] {
	const out: Unit[] = [];
	for (const u of units) {
		const prev = out[out.length - 1];
		const orphaned =
			prev !== undefined &&
			prev.section === u.section &&
			(RESOLVES_PREVIOUS_RE.test(nt.slice(u.start, u.end).trim()) ||
				LEAVES_CLAUSE_OPEN_RE.test(nt.slice(prev.start, prev.end).trim()));
		if (orphaned && prev !== undefined) {
			out[out.length - 1] = carry(
				prev,
				prev.start,
				u.end,
				prev.brokeAtTokenLevel || u.brokeAtTokenLevel
			);
			continue;
		}
		out.push(u);
	}
	return out;
}

function explode(nt: string, u: Unit, target: number, countTokens: CountTokens, out: Unit[]): void {
	if (countTokens(nt.slice(u.start, u.end)) <= target) {
		out.push(u);
		return;
	}
	const text = nt.slice(u.start, u.end);

	const sents = splitSentences(text);
	if (sents.length > 1) {
		for (const s of sents)
			explode(nt, carry(u, u.start + s.start, u.start + s.end, false), target, countTokens, out);
		return;
	}

	// Markers are the FALLBACK, reached only where the text carries no sentence boundary to cut on -
	// which is exactly the flattened-list case they exist for. Trying them first instead cuts inside
	// sentences that already fit, welding the fragment onto its neighbour; measured over the real corpus,
	// that moved 59% of chunk texts and cost 5 benchmark queries their tier-1 answer while the reachable
	// ceiling rose, i.e. it degraded which card leads rather than what retrieval can reach.
	const paras = splitParagraphs(text);
	if (paras.length > 1) {
		for (const p of paras)
			explode(nt, carry(u, u.start + p.start, u.start + p.end, false), target, countTokens, out);
		return;
	}

	tokenWindows(nt, u, target, countTokens, out);
}

/**
 * Cut a source into ordered, no-overlap `ChunkSpan`s over its `normalizedText`. Packs consecutive same-section
 * units (block -> sentence -> list marker -> token window) greedily up to `targetTokens`; never merges across a section
 * boundary. A short trailing chunk is left as-is - greedy packing already merges everything that fits, so a
 * tiny tail survives only when folding it would breach the window. Each span's `text` is a verbatim slice
 * `normalizedText[start, end)`. Pure (tokenizer injected). Throws `E_CHUNK_BLOCK_NOT_LOCATED` if a block is
 * not a verbatim substring (the rare hyphen-fusion edge).
 */
export function splitIntoSpans(
	normalizedText: string,
	blocks: Block[],
	countTokens: CountTokens,
	opts?: SplitOpts
): ChunkSpan[] {
	const target = opts?.targetTokens ?? DEFAULT_TARGET;

	const exploded: Unit[] = [];
	for (const block of mapBlockOffsets(normalizedText, blocks))
		explode(normalizedText, block, target, countTokens, exploded);
	const units = joinUnresolved(normalizedText, exploded);

	// Pack units into chunks, never crossing a section boundary, up to target.
	const chunks: Unit[] = [];
	let i = 0;
	while (i < units.length) {
		const head = units[i];
		if (head === undefined) break;
		let end = head.end;
		let broke = head.brokeAtTokenLevel;
		let j = i + 1;
		while (j < units.length) {
			const next = units[j];
			if (next === undefined || next.section !== head.section) break;
			if (countTokens(normalizedText.slice(head.start, next.end)) > target) break;
			end = next.end;
			broke = broke || next.brokeAtTokenLevel;
			j++;
		}
		chunks.push(carry(head, head.start, end, broke));
		i = j;
	}

	return chunks.map((u) => {
		// Trim whitespace at the chunk edges, keeping text == slice(start, end): sentence spans absorb their
		// trailing boundary whitespace and a token window can open on an inter-word space, so the raw unit
		// bounds can sit on a space. The trimmed whitespace is a permitted gap between chunks (coverage allows
		// boundaries on whitespace); the chunk text stays a verbatim slice at its recorded offsets.
		let start = u.start;
		let end = u.end;
		while (start < end && /\s/.test(normalizedText.charAt(start))) start++;
		while (end > start && /\s/.test(normalizedText.charAt(end - 1))) end--;
		const span: ChunkSpan = {
			text: normalizedText.slice(start, end),
			startOffset: start,
			endOffset: end,
			brokeAtTokenLevel: u.brokeAtTokenLevel
		};
		if (u.page !== undefined) span.page = u.page;
		if (u.section !== undefined) span.section = u.section;
		return span;
	});
}
