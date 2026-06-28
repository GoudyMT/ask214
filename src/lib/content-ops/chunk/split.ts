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

function explode(nt: string, u: Unit, target: number, countTokens: CountTokens, out: Unit[]): void {
	if (countTokens(nt.slice(u.start, u.end)) <= target) {
		out.push(u);
		return;
	}
	const sents = splitSentences(nt.slice(u.start, u.end));
	if (sents.length > 1) {
		for (const s of sents)
			explode(nt, carry(u, u.start + s.start, u.start + s.end, false), target, countTokens, out);
		return;
	}
	tokenWindows(nt, u, target, countTokens, out);
}

/**
 * Cut a source into ordered, no-overlap `ChunkSpan`s over its `normalizedText`. Packs consecutive same-section
 * units (block -> sentence -> token window) greedily up to `targetTokens`; never merges across a section
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

	const units: Unit[] = [];
	for (const block of mapBlockOffsets(normalizedText, blocks))
		explode(normalizedText, block, target, countTokens, units);

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
