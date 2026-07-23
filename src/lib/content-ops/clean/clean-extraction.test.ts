import { describe, it, expect, vi } from 'vitest';
import type { Block } from '$lib/content-ops/extract/pdf-text';
import { cleanExtraction } from './clean-extraction';
import { detectRunningAffix } from './detect-running-affix';
import { stripFused } from './strip-fused';

// Real text below is copied verbatim from tap_managing_transition.json (gitignored under
// content-ops/extracted/, so unreadable in CI - hence hardcoded here, matching the convention
// already used by detect-running-affix.test.ts and classify-block.test.ts for the same document).

// tap_managing_transition.json block 2, page 3: the standalone DoD/VA disclaimer paragraph.
const DISCLAIMER_BLOCK: Block = {
	text: 'DISCLAIMER: The information provided herein does not constitute a formal endorsement of any company, its product, or services by the U.S. Department of War (DoW). Specifically, the appearance or use of external hyperlinks does not constitute endorsement by the DoW of the linked websites or the information, products, or services contained therein. The DoW does not exercise any editorial control over the information found at these locations. While this information provides informational resource materials to assist military personnel and their families in identifying or exploring resources and options, the resources provided are not exhaustive. All websites and URLs in this guide were active at the date of publication. However, web content is subject to change without notice. Users of this guide are advised to confirm information is current.',
	page: 3
};

// tap_managing_transition.json blocks 3-14 (pages 4-15, 12 blocks): the same fixture set
// detect-running-affix.test.ts uses to prove its running-header detection, reused here so the
// affix this test exercises is the one already independently verified against real data - not a
// new, unverified guess. Every block shares the "| 2026Managing Your (MY) Transition" running
// header fused directly onto its own page number with no separator.
const MANAGING_TRANSITION_BLOCKS: Block[] = [
	{
		text: '| 2026Managing Your (MY) Transition4 Welcome to Managing Your (MY) Transition Introduction This transition course discusses common concerns that may o',
		page: 4
	},
	{
		text: '| 2026Managing Your (MY) Transition5 Transition Overview Preparation for transition occurs at various touchpoints of your military career as part of t',
		page: 5
	},
	{
		text: '| 2026Managing Your (MY) Transition6 Consider the following statistics from the U.S. Census Bureau: ',
		page: 6
	},
	{
		text: '| 2026Managing Your (MY) Transition7 The following chart provides descriptions of the TAP courses and their associated CRS. Required CRS are determine',
		page: 7
	},
	{
		text: '| 2026Managing Your (MY) Transition8 Courses Description CRS Two-Day Tracks DOL Employment Track',
		page: 8
	},
	{
		text: '| 2026Managing Your (MY) Transition9 Managing Your Transition Timeline Ideally, Service members should begin TAP 24 months before retirement or 18 mon',
		page: 9
	},
	{
		text: '| 2026Managing Your (MY) Transition10 Managing your Transition Loss of Purpose and Identity When transitioning, many Service members look forward to l',
		page: 10
	},
	{
		text: '| 2026Managing Your (MY) Transition11 In contrast to joining the military, transitioning back into the civilian sector tends to be more complex as it ',
		page: 11
	},
	{
		text: '| 2026Managing Your (MY) Transition12 further a cause important to you. This could mean volunteering, coaching a youth sports team, leading a faith-ba',
		page: 12
	},
	{
		text: '| 2026Managing Your (MY) Transition13 Transition Concerns It is normal for you to have concerns about life after the military while going through the ',
		page: 13
	},
	{
		text: '| 2026Managing Your (MY) Transition14 Below is a list of common concerns identified by TAP counselors and transitioning Service members during previou',
		page: 14
	},
	{
		text: '| 2026Managing Your (MY) Transition15 Resiliency in Transition Even with preparation, some aspects of your transition will be stressful. However, in t',
		page: 15
	}
];

// SYNTHETIC (not real data): a 13th header-bearing block that is nothing but the running header
// plus its own page number - built from the same, already-verified real header segment above so
// the affix it exercises is genuine, but no real block in this corpus happens to be quite this
// bare. Closes the "stripped to nothing" drop path, which a real page never triggers here (every
// real page in this document carries at least some prose after its header).
const HEADER_ONLY_STUB: Block = {
	text: '| 2026Managing Your (MY) Transition16',
	page: 16
};

// Marks a block whose classification is stubbed below AUTO_DROP_THRESHOLD (see the vi.mock below).
const REVIEW_SENTINEL_TEXT =
	'A block whose real classification score classify-block.ts cannot currently produce, standing in for a future non-content signal too weak to trust with an automatic drop.';

// classify-block.ts's own toc/frontmatter thresholds make ANY firing non-content classification
// below 0.75 confidence mathematically unreachable today: a brute-force sweep of every reachable
// scoreToc/scoreFrontMatter value (every integer token-fraction and dotted-leader count scoreToc
// can see, every length/density combination scoreFrontMatter can see) floors at exactly 0.75, and a
// sweep of the real 38-document corpus confirms it (minimum observed: 0.75, a real ToC block in
// tap_pre_separation_brief.json). AUTO_DROP_THRESHOLD is deliberately set below that floor (see
// clean-extraction.ts), which means cleanExtraction's review-routing branch cannot be reached by
// any real classifyBlock call today - it exists for a future, weaker non-content signal. Stubbing
// classifyBlock for one sentinel text is the only way to exercise that branch honestly; every
// other test in this file uses the real classifier, unmodified, on real or realistic input.
vi.mock('./classify-block', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./classify-block')>();
	return {
		...actual,
		classifyBlock: (block: Block) =>
			block.text === REVIEW_SENTINEL_TEXT
				? { kind: 'toc' as const, confidence: 0.6 }
				: actual.classifyBlock(block)
	};
});

/** Asserts the split.ts chunker invariant: every block's text is a verbatim, in-order substring of normalizedText. */
function assertInOrderSubstring(blocks: Block[], normalizedText: string): void {
	let cursor = 0;
	for (const b of blocks) {
		const idx = normalizedText.indexOf(b.text, cursor);
		expect(idx).toBeGreaterThanOrEqual(0);
		cursor = idx + b.text.length;
	}
}

describe('cleanExtraction', () => {
	it('drops the disclaimer block, strips the fused running header from every surviving block, and re-derives a consistent normalizedText', () => {
		const extraction = {
			blocks: [DISCLAIMER_BLOCK, ...MANAGING_TRANSITION_BLOCKS],
			normalizedText: 'ignored - re-derived'
		};

		const { cleaned, report } = cleanExtraction(extraction, {});

		expect(cleaned.blocks).toHaveLength(12);
		expect(report.dropped).toHaveLength(1);
		expect(report.dropped[0]).toMatchObject({ page: 3, kind: 'disclaimer' });
		expect(report.stripped).toHaveLength(12);
		expect(report.review).toHaveLength(0);

		// Cross-check against the real, independently-tested units directly (not a hand-typed
		// literal): proves cleanExtraction wires detectRunningAffix's output into stripFused for the
		// right block, rather than merely asserting a guessed string.
		const affix = detectRunningAffix(extraction.blocks);
		expect(affix.prefix).toContain('| 2026Managing Your (MY) Transition');
		const [firstManagingBlock] = MANAGING_TRANSITION_BLOCKS;
		expect(firstManagingBlock).toBeDefined();
		expect(cleaned.blocks[0]?.text).toBe(stripFused(firstManagingBlock?.text ?? '', affix));

		// no survivor still carries the raw fused header
		expect(
			cleaned.blocks.every((b) => !b.text.includes('| 2026Managing Your (MY) Transition'))
		).toBe(true);

		assertInOrderSubstring(cleaned.blocks, cleaned.normalizedText);
	});

	it('passes a clean source through unchanged (no affix, no junk blocks -> equal blocks, empty drop/strip/review)', () => {
		const clean = {
			blocks: [
				{ text: 'Apply online for VA health care.', page: 1 },
				{ text: 'You can also apply by phone at any time.', page: 2 }
			],
			normalizedText: 'x'
		};

		const { cleaned, report } = cleanExtraction(clean, {});

		expect(cleaned.blocks).toEqual(clean.blocks);
		expect(report.dropped).toHaveLength(0);
		expect(report.stripped).toHaveLength(0);
		expect(report.review).toHaveLength(0);
		assertInOrderSubstring(cleaned.blocks, cleaned.normalizedText);
	});

	it('drops a block that strips to nothing but a bare header/page-number stub, recording kind "empty"', () => {
		const extraction = {
			blocks: [...MANAGING_TRANSITION_BLOCKS, HEADER_ONLY_STUB],
			normalizedText: 'ignored - re-derived'
		};

		const { cleaned, report } = cleanExtraction(extraction, {});

		expect(cleaned.blocks).toHaveLength(12);
		expect(cleaned.blocks.some((b) => b.page === 16)).toBe(false);
		expect(report.dropped).toHaveLength(1);
		expect(report.dropped[0]).toMatchObject({ page: 16, kind: 'empty' });
		expect(report.dropped[0]?.preview).toBe(HEADER_ONLY_STUB.text.slice(0, 80));

		assertInOrderSubstring(cleaned.blocks, cleaned.normalizedText);
	});

	it('keeps and flags for review a block classifyBlock scores as non-content below AUTO_DROP_THRESHOLD, instead of dropping it', () => {
		const extraction = {
			blocks: [{ text: REVIEW_SENTINEL_TEXT, page: 5 }],
			normalizedText: 'ignored - re-derived'
		};

		const { cleaned, report } = cleanExtraction(extraction, {});

		expect(cleaned.blocks).toHaveLength(1);
		expect(cleaned.blocks[0]?.text).toBe(REVIEW_SENTINEL_TEXT);
		expect(report.dropped).toHaveLength(0);
		expect(report.stripped).toHaveLength(0);
		expect(report.review).toHaveLength(1);
		expect(report.review[0]).toEqual({
			page: 5,
			kind: 'toc',
			confidence: 0.6,
			preview: REVIEW_SENTINEL_TEXT.slice(0, 80)
		});

		assertInOrderSubstring(cleaned.blocks, cleaned.normalizedText);
	});

	it('shows a tail edit in the review diff so a human can see it, not just the unchanged head', () => {
		// A long content block whose only edit is a trailing dotted-leader stub past the snippet head.
		// A head-only before/after snippet would be identical and hide the edit from the review report -
		// exactly how a tail strip could remove real content unseen.
		const body =
			'This is a long line of real government content that continues well past the review snippet head length so the only difference is in the tail';
		const extraction = {
			blocks: [{ text: `${body}......20`, page: 8 }],
			normalizedText: 'ignored - re-derived'
		};

		const { report } = cleanExtraction(extraction, {});

		expect(report.stripped).toHaveLength(1);
		expect(report.stripped[0]?.before).not.toBe(report.stripped[0]?.after);
		expect(report.stripped[0]?.before).toContain('......20');
	});
});
