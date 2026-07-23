import type { Block } from '$lib/content-ops/extract/pdf-text';
import { detectRunningAffix } from './detect-running-affix';
import { classifyBlock } from './classify-block';
import { stripFused } from './strip-fused';
import { blocksToNormalizedText } from './derive-normalized';

// A non-content classification at or above this confidence auto-drops its whole block; below it,
// the block is kept (stripped) and flagged in report.review for a human instead. classify-block.ts's
// own toc/frontmatter heuristics make any FIRING non-content score below 0.75 mathematically
// unreachable today (verified: a brute-force sweep of every token-fraction/dotted-leader/density
// combination those heuristics can see floors at exactly 0.75; the real 38-document corpus confirms
// it, bottoming out at that same 0.75 on a real ToC block). 0.7 sits a clean 0.05 under that floor,
// so every genuine boilerplate block measured in this corpus clears it, while still reserving the
// [0.7, 0.75) lane for a future, weaker non-content signal that should get a human's eyes rather
// than a silent auto-drop.
const AUTO_DROP_THRESHOLD = 0.7;

// Preview/snippet lengths for the human-facing report: short enough to skim, long enough to
// recognize the block. The before/after diff gets more room than a plain preview since a reviewer
// needs to see what actually changed, not just what the block was.
const PREVIEW_LENGTH = 80;
const DIFF_SNIPPET_LENGTH = 120;

export type CleanConfig = Record<string, never>;

export type CleanReport = {
	dropped: { page?: number; kind: string; preview: string }[];
	stripped: { page?: number; before: string; after: string }[];
	review: { page?: number; kind: string; preview: string; confidence: number }[];
};

type DroppedEntry = CleanReport['dropped'][number];
type StrippedEntry = CleanReport['stripped'][number];
type ReviewEntry = CleanReport['review'][number];

/** Head+tail snippet of a block for the review diff. A strip can edit either end of a block (a leading
 *  header or a trailing footer/leader), so a head-only slice would hide a tail edit entirely - showing
 *  both ends keeps every edit visible to the human reviewer regardless of where in the block it lands. */
function diffSnippet(text: string): string {
	if (text.length <= DIFF_SNIPPET_LENGTH) return text;
	const half = Math.floor(DIFF_SNIPPET_LENGTH / 2);
	return `${text.slice(0, half)} [...] ${text.slice(-half)}`;
}

/** Builds a dropped-block report entry; page is only assigned when present, since CleanReport's
 *  optional `page` must be omitted rather than set to a literal undefined. */
function toDroppedEntry(block: Block, kind: string): DroppedEntry {
	const entry: DroppedEntry = { kind, preview: block.text.slice(0, PREVIEW_LENGTH) };
	if (block.page !== undefined) entry.page = block.page;
	return entry;
}

/**
 * Cleans one extraction: drops whole-block boilerplate (a table of contents, the standard
 * disclaimer, cover front-matter), strips a fused running header/footer from the blocks that
 * survive, and re-derives normalizedText from the result. Every edit is recorded in the returned
 * report for human review - a kept-but-uncertain non-content block is flagged there rather than
 * dropped, since a wrong drop destroys real content while a wrong keep only costs a human a second
 * look.
 *
 * Args:
 *     extraction: The raw extraction (blocks + normalizedText) to clean. normalizedText is ignored
 *         on input - it is fully re-derived from the surviving, edited blocks.
 *     config: Per-document override hook, currently unused.
 *
 * Returns:
 *     The cleaned extraction (survivors plus re-derived normalizedText, satisfying the same
 *     in-order-substring contract split.ts's mapBlockOffsets relies on) plus the edit report.
 */
export function cleanExtraction(
	extraction: { blocks: Block[]; normalizedText: string },
	config: CleanConfig
): { cleaned: { blocks: Block[]; normalizedText: string }; report: CleanReport } {
	void config; // unused per-doc override hook, reserved for a future per-source tuning need

	const affix = detectRunningAffix(extraction.blocks);
	const report: CleanReport = { dropped: [], stripped: [], review: [] };
	const survivors: Block[] = [];

	for (const block of extraction.blocks) {
		const c = classifyBlock(block);

		if (c.kind !== 'content' && c.confidence >= AUTO_DROP_THRESHOLD) {
			report.dropped.push(toDroppedEntry(block, c.kind));
			continue;
		}

		const stripped = stripFused(block.text, affix);
		if (stripped.length === 0) {
			report.dropped.push(toDroppedEntry(block, 'empty'));
			continue;
		}

		survivors.push({ ...block, text: stripped });

		if (stripped !== block.text) {
			const strippedEntry: StrippedEntry = {
				before: diffSnippet(block.text),
				after: diffSnippet(stripped)
			};
			if (block.page !== undefined) strippedEntry.page = block.page;
			report.stripped.push(strippedEntry);
		}

		// Reaching here with a non-content kind means the auto-drop check above did NOT fire, i.e.
		// this block's confidence is already below AUTO_DROP_THRESHOLD - a human should confirm it.
		if (c.kind !== 'content') {
			const reviewEntry: ReviewEntry = {
				kind: c.kind,
				preview: stripped.slice(0, PREVIEW_LENGTH),
				confidence: c.confidence
			};
			if (block.page !== undefined) reviewEntry.page = block.page;
			report.review.push(reviewEntry);
		}
	}

	const normalizedText = blocksToNormalizedText(survivors);
	return { cleaned: { blocks: survivors, normalizedText }, report };
}
