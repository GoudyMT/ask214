import type { Block } from '$lib/content-ops/extract/pdf-text';

/** A running header/footer learned from a document: the ordered CONSTANT text segments that
 *  repeat at the start (prefix) or end (suffix) of most blocks, with a variable page-number run
 *  permitted before/between/after the segments. Empty arrays mean no repeated affix was found. */
export type RunningAffix = { prefix: string[]; suffix: string[] };

// A block shorter than this cannot plausibly carry a full header/footer stamp - excluding it from
// the eligible-block count keeps a page's worth of near-empty stub blocks (a bare page break, a
// one-word artifact) from diluting the denominator threshold is measured against.
const MIN_BLOCK_LENGTH_FOR_AFFIX = 20;

// Below this many eligible blocks, skip detection entirely and return empty. A running header only
// exists because it repeats across many pages of the SAME document - a document with only a
// handful of blocks has no page to repeat across, so any shared text is more likely genuine shared
// content (a short guide's two pages both opening with the same cover/title text) than a template.
// Measured across every extraction in this corpus: block counts are cleanly bimodal, topping out at
// 10 for the small single-page sources and starting at 25 for the real multi-page guides, with
// nothing in between - 12 sits in that empty gap, comfortably above the small-source ceiling.
const MIN_BLOCKS_FOR_AFFIX = 12;

// A segment must be shared by at least this fraction of eligible blocks to count as part of the
// running affix. The header/footer repeats on most content pages but not the cover, table of
// contents, or disclaimer, so a bare majority - not unanimity - is the right bar.
const THRESHOLD_FRACTION = 0.5;

// A candidate segment shorter than this, or with no letters at all, is discarded as noise (stray
// punctuation, a lone joining space) rather than recorded as a real constant segment. Measured
// against real coincidental tail overlaps in this corpus (two unrelated sentences both happening
// to end "...s.") which never exceed 2-3 characters, while every genuine header/footer segment
// measured here runs 20+ characters - this sits comfortably between the two.
const MIN_SEGMENT_LENGTH = 5;

// Hard cap on how many alternating segment / variable-run pairs to look for, purely to bound the
// loop. The richest real running header measured in this corpus has 2 segments (a title stamp plus
// a version/date stamp); this is headroom, not a claimed maximum.
const MAX_SEGMENTS = 4;

// The variable run between (or after) constant segments is the page number: zero or more digits
// plus at most one adjoining space (the space separating the page number from whatever sits next
// to it, on whichever side it falls in this document's template). Every part is optional so this
// always matches (possibly the empty string), consuming exactly the token that varies per block.
const VARIABLE_RUN_RE = /^\s?\d*\s?/;

// A page number is at most 3 digits here (a 4-digit year or a longer numeric id is not one). Only a
// digit run this short counts as the variable page token to skip between constant segments; a longer run
// is content, so the shared segment ends there. Mirrors strip-fused.ts's MAX_PAGE_NUMBER_DIGITS exactly.
const MAX_PAGE_NUMBER_DIGITS = 3;

type CommonPrefixResult = { segment: string; matchedTexts: string[] };

/**
 * Finds the longest leading run shared by at least `threshold` of `total` texts.
 *
 * Grows the candidate segment one character at a time. The first character's support count must
 * clear `threshold`; every character after that is required to hold that SAME support count, not
 * merely stay above threshold. A real constant segment in this corpus (verified against actual
 * extracted PDF headers/footers) shows zero attrition across its whole span and then a sharp cliff
 * at its true boundary. A gradual, multi-step erosion is the signature of a different phenomenon -
 * e.g. a chapter-level sub-header that repeats across many, but not all, pages - that only
 * coincidentally shares its opening characters with the true document-wide constant, and folding
 * it in would corrupt the segment with text that is not actually invariant.
 *
 * Args:
 *     activeTexts: Remaining text for each still-in-the-running block (already past any prior
 *         segment and variable-run skip in this search direction).
 *     total: The fixed eligible-block count `threshold` is measured against.
 *     threshold: Required support fraction, e.g. 0.5 for a bare majority.
 *
 * Returns:
 *     The discovered segment (possibly empty) and the full, unsliced texts that support it.
 */
function findCommonPrefix(
	activeTexts: string[],
	total: number,
	threshold: number
): CommonPrefixResult {
	let texts = activeTexts;
	let segment = '';
	let pos = 0;
	let lockedCount: number | null = null;

	for (;;) {
		const groups = new Map<string, string[]>();
		for (const s of texts) {
			if (pos >= s.length) continue;
			const ch = s[pos];
			if (ch === undefined) continue;
			const group = groups.get(ch);
			if (group) {
				group.push(s);
			} else {
				groups.set(ch, [s]);
			}
		}

		let bestChar: string | undefined;
		let bestGroup: string[] = [];
		for (const [ch, group] of groups) {
			if (group.length > bestGroup.length) {
				bestChar = ch;
				bestGroup = group;
			}
		}
		if (bestChar === undefined) break;

		if (lockedCount === null) {
			if (bestGroup.length / total < threshold) break;
			lockedCount = bestGroup.length;
		} else if (bestGroup.length < lockedCount) {
			break;
		}

		segment += bestChar;
		texts = bestGroup;
		pos += 1;
	}

	return { segment, matchedTexts: texts };
}

/** Reverses a string so `findCommonPrefix` can be reused, unmodified, to find a shared suffix. */
function reverseString(s: string): string {
	return s.split('').reverse().join('');
}

/**
 * Repeatedly finds and strips one constant segment at a time, skipping the variable run after
 * each, until a candidate segment is trivial (too short or has no letters) or the active set of
 * supporting texts runs dry.
 *
 * Args:
 *     texts: Eligible block texts, oriented so "leading" means the direction being searched -
 *         as-is for a prefix scan, already reversed for a suffix scan.
 *     total: The fixed eligible-block count `threshold` is measured against.
 *     threshold: Required support fraction.
 *
 * Returns:
 *     The ordered constant segments found, in the same orientation as `texts`. The caller is
 *     responsible for reversing each segment (and the array) back when scanning for a suffix.
 */
function findSegments(texts: string[], total: number, threshold: number): string[] {
	let active = texts;
	const segments: string[] = [];

	for (let i = 0; i < MAX_SEGMENTS; i++) {
		if (active.length === 0) break;

		const { segment, matchedTexts } = findCommonPrefix(active, total, threshold);
		const trimmed = segment.trim();
		if (trimmed.length < MIN_SEGMENT_LENGTH || !/[a-zA-Z]/.test(trimmed)) break;
		segments.push(trimmed);

		active = matchedTexts.map((s) => {
			const remainder = s.slice(segment.length);
			const run = remainder.match(VARIABLE_RUN_RE)?.[0] ?? '';
			// Only a page-number-shaped digit run is the variable token to skip; a longer run (id/year)
			// is content, so treat the segment as ending here rather than skipping across real text.
			const skipLength = (run.match(/\d/g) ?? []).length <= MAX_PAGE_NUMBER_DIGITS ? run.length : 0;
			return remainder.slice(skipLength);
		});
	}

	return segments;
}

/**
 * Learns a document's running header/footer: the constant text segments that repeat at the start
 * and/or end of most blocks, separated by a variable page number. Detects by diffing block starts
 * (and, symmetrically, block ends): the longest run shared by a majority of blocks is the first
 * constant segment; where blocks diverge is the variable page number, which is skipped before
 * searching for the next constant segment; this repeats until nothing more repeats.
 *
 * Args:
 *     blocks: The extracted blocks for one document, in reading order. Only `text` is read.
 *
 * Returns:
 *     The learned affix. Either array is empty when no repeated segment clears the threshold, or
 *     when the document has too few eligible blocks to learn a running affix from at all.
 */
export function detectRunningAffix(blocks: Block[]): RunningAffix {
	const eligible = blocks.map((b) => b.text).filter((t) => t.length >= MIN_BLOCK_LENGTH_FOR_AFFIX);
	const total = eligible.length;
	if (total < MIN_BLOCKS_FOR_AFFIX) return { prefix: [], suffix: [] };

	const prefix = findSegments(eligible, total, THRESHOLD_FRACTION);

	const reversedSegments = findSegments(eligible.map(reverseString), total, THRESHOLD_FRACTION);
	const suffix = reversedSegments.map(reverseString).reverse();

	return { prefix, suffix };
}
