import { describe, it, expect } from 'vitest';
import { classifyBlock } from './classify-block';

// Every fixture text below is copied verbatim from a real extracted PDF guide under
// content-ops/extracted/ (gitignored, so unreadable in CI - hence hardcoded here rather than
// read from disk). Where the source PDF text contains a non-ASCII character, it is rebuilt with
// String.fromCharCode so this source file itself stays ASCII-only.
const EM_DASH = String.fromCharCode(0x2014); // U+2014 em dash, as extracted from the source PDF
const BULLET = String.fromCharCode(0x25a0); // U+25A0 black square, used as a list bullet in the source PDF

// Reused across two tests: a real content block whose running header got fused onto the front of
// the block by the extractor (Class 2 territory, stripped later - not this classifier's job).
const FUSED_HEADER_CONTENT =
	'| 2026Managing Your (MY) Transition4 Welcome to Managing Your (MY) Transition Introduction This transition course discusses common concerns that may occur during transition and covers some less obvious topics' +
	EM_DASH +
	'loss of purpose, identity, and tribe; new stressors that may result during transition and strategies to manage them; differences in the culture of civilian and military life; the value of a mentor and how to obtain one; and resources available during and after transition. These issues may have a significant impact on the transition process and need to be considered when creating your Individual Transition Plan (ITP).';

describe('classifyBlock', () => {
	describe('toc', () => {
		it('classifies a real table-of-contents block with inline trailing page numbers (tap_managing_transition.json block 1, page 2)', () => {
			const result = classifyBlock({
				page: 2,
				text: 'CONTENTSTable of Contents Disclaimer: 3 Welcome to Managing Your (MY) Transition 4 Transition Overview 5 Managing your Transition 10 Loss of Purpose and Identity 10 Transition Concerns 13 Resiliency in Transition 15 Managing Transition Stress 16 Military vs. Civilian Culture 18 Value of Mentors 21 Resources 22'
			});
			// This real ToC lists "Disclaimer:" as one of its own entries, so the disclaimer word
			// signal fires too - proving the picked-max logic favors the stronger toc signal here.
			expect(result.kind).toBe('toc');
			expect(result.confidence).toBeGreaterThan(0.5);
		});

		it('classifies a real dotted-leader table-of-contents block (tap_dol_employment_workshop.json block 2, page 3)', () => {
			const result = classifyBlock({
				page: 3,
				text: 'TABLE OF CONTENTS Department Of Labor Employment Workshop (DOLEW) Materials......................................... 10 Section 1: Introduction................................................................................................................ 12 Welcome.................................................................................................................................. 12 Workshop Goals................................................................................................................. 12 Focus of Each Workshop Section...................................................................................... 13 Activity 1.1: Introductions................................................................................................... 13'
			});
			expect(result.kind).toBe('toc');
			expect(result.confidence).toBeGreaterThan(0.5);
		});

		it('classifies a marker-less multi-page toc continuation page purely on dotted-leader density (tap_dol_employment_workshop.json block 5, page 6)', () => {
			const result = classifyBlock({
				page: 6,
				text: 'Section 4: Networking................................................................................................................. 90 Section Objectives............................................................................................................. 90 What is Networking?............................................................................................................... 91 Activity 4.1: Expand Your Network.................................................................................... 91 Reaching Your Network.......................................................................................................... 92 Informal Networking.......................................................................................................... 92 Conduct Informational Interviews............................................................................................ 94 Tips for Setting Up Informational Interviews....................................................................... 94 Activity 4.2: Explore Informational Interviews.................................................................... 95 Formal Networking.................................................................................................................. 96 Join Your Professional or Trade Organizations................................................................. 96 Find a Mentor..................................................................................................................... 96 Attending Networking Events and Job Fairs............................................................................ 97'
			});
			// This is page 6 of a multi-page toc - only the FIRST toc page in this document (block 2)
			// carries the "TABLE OF CONTENTS" marker; this continuation page carries none, but is just
			// as unambiguously a contents page from its dotted-leader density alone. The orchestrator
			// auto-drops non-content at confidence >= 0.7, so this path must clear that bar.
			expect(result.kind).toBe('toc');
			expect(result.confidence).toBeGreaterThanOrEqual(0.7);
		});
	});

	describe('disclaimer', () => {
		it('classifies the full DoD/VA disclaimer boilerplate at maximum confidence (tap_managing_transition.json block 2, page 3)', () => {
			const result = classifyBlock({
				page: 3,
				text: 'DISCLAIMER: The information provided herein does not constitute a formal endorsement of any company, its product, or services by the U.S. Department of War (DoW). Specifically, the appearance or use of external hyperlinks does not constitute endorsement by the DoW of the linked websites or the information, products, or services contained therein. The DoW does not exercise any editorial control over the information found at these locations. While this information provides informational resource materials to assist military personnel and their families in identifying or exploring resources and options, the resources provided are not exhaustive. All websites and URLs in this guide were active at the date of publication. However, web content is subject to change without notice. Users of this guide are advised to confirm information is current.'
			});
			expect(result.kind).toBe('disclaimer');
			expect(result.confidence).toBe(1);
		});
	});

	describe('frontmatter', () => {
		it('classifies a real cover-page stub of title + version + date with no real prose (tap_dol_employment_workshop.json block 0, page 1)', () => {
			const result = classifyBlock({
				page: 1,
				text: 'U.S. DEPARTMENT OF LABOR Employment Workshop (DOL EW) PARTICIPANT GUIDE Version 6.0 Update 1 March 2026'
			});
			expect(result.kind).toBe('frontmatter');
			expect(result.confidence).toBeGreaterThan(0.5);
		});

		it('SYNTHETIC edge case (not real data): a short early-page block with a version and a date but genuine dense prose must not classify as frontmatter', () => {
			// Real early-page blocks in this corpus that carry a version+date stamp are either a
			// near-empty cover stub (~100 chars) or 600+ chars of real content - nothing in the
			// corpus is short AND dense with real sentences at the same time, so this exact
			// combination is hand-built to close that branch out, not copied from an extraction.
			const result = classifyBlock({
				page: 2,
				text: 'Version 5.2. Released June 2026. This guide explains your separation benefits. Read every section fully. Ask your transition counselor if anything is unclear.'
			});
			expect(result.kind).toBe('content');
			expect(typeof result.confidence).toBe('number');
		});
	});

	describe('content - guards against false positives', () => {
		it('keeps a real content block whose running header got fused onto its front (tap_managing_transition.json block 3, page 4)', () => {
			const result = classifyBlock({ page: 4, text: FUSED_HEADER_CONTENT });
			expect(result.kind).toBe('content');
			expect(typeof result.confidence).toBe('number');
		});

		it('keeps a real content block that mentions "version" via a fused per-page footer stamp (tap_va_benefits_guide.json block 30, page 31)', () => {
			const result = classifyBlock({
				page: 31,
				text: 'VA Benefits and Services Participant Guide18Version 6 1 September 2025Module 1: Introduction to Benefits and Services Self-Guided Activity: Update Your Personal Goals Checklist Goal 1: Prepare for my upcoming transition Timeline or Deadline Notes Create a Login.gov account to access the VA.gov website resources. Prior to leaving this course Set up a One-On-One Assistance session with a Benefits Advisor. Prior to leaving or any time after this course Complete the Transition Assistance Participant Assessment (TAPA) for this course. As soon as possible, after completing this course Check my separation documents for accuracy. As soon as I receive them Store printed separation documents in a safe place and let others know where they are located. After reviewing them for accuracy (Optional) Register separation documents with the county I plan to live in once I separate from service. After reviewing them for accuracy'
			});
			expect(result.kind).toBe('content');
			expect(typeof result.confidence).toBe('number');
		});

		it('keeps a real early-page (page <= 3) block that ALSO mentions version + a date, since it is genuine prose and not a cover stub (tap_va101.json block 0, page 1)', () => {
			const result = classifyBlock({
				page: 1,
				text: 'Linkspage 1VA Benefits 101 Online Resource Guide Version 4.0 Released February 2023, Revised May 2025 ONLINE RESOURCE GUIDE The Transition Assistance Program (TAP) provides training, information and services to help Service members and their families transition to civilian life. The Military Life Cycle (MLC) modules help Service members, Veterans and their families take full advantage of VA benefits and services. The VA Benefits 101 module presents an overview of the benefits and services that the VA provides. This Online Resource Guide provides you with the web links to important resources related to the course. VA TAP ONLINE COURSES The VA TAP Course Catalog is a comprehensive resource that includes information about all VA TAP course offerings, direct links to on-demand web-based trainings and downloadable resource materials. To access these courses, navigate to the VA TAP Course Catalog (or scan the QR code at the top of this page) and select from the list of courses available in the VA TAP Curriculum. VA Benefits 101 MILITARY LIFE CYCLE'
			});
			// This is the exact false-positive shape the classifier must resist: early page, a
			// version number, and a publication date all present - but the block is a genuine
			// multi-sentence description of the module, not a cover stub, so it must stay content.
			expect(result.kind).toBe('content');
			expect(typeof result.confidence).toBe('number');
		});

		it('keeps a real content block that contains a couple of numbers (tap_financial_planning.json block 33, page 34)', () => {
			const result = classifyBlock({
				page: 34,
				text: '| 2026Financial Planning for Transition34 ACTIVITY: Review Cost of Living Changes for a New Location 1. Use the BankRate.com website or a different cost-of-living calculator to review the differences in salary requirements and cost of living for housing, insurance, utilities, etc. 2. Add the amounts to the spending plan. DoW Spending Plan Instructions: On the Expenses tab, choose a few of the expenses to add to the projected column. Add the salary requirement in the salary equivalent line under projected. Do not forget to include the new location in the space provided.'
			});
			expect(result.kind).toBe('content');
			expect(typeof result.confidence).toBe('number');
		});

		it('keeps a real short early-page cover-like block that lacks the version/date stamp (tap_dol_efct.json block 0, page 1)', () => {
			const result = classifyBlock({
				page: 1,
				text: 'Employment Fundamentals of Career Transition (EFCT) Employment Fundamentals of Career Transition (EFCT) U.S. DEPARTMENT OF LABOR PARTICIPANT GUIDE'
			});
			expect(result.kind).toBe('content');
			expect(typeof result.confidence).toBe('number');
		});

		it('treats a block with no page number as not early-page, still keeping real content', () => {
			const result = classifyBlock({ text: FUSED_HEADER_CONTENT });
			expect(result.kind).toBe('content');
			expect(typeof result.confidence).toBe('number');
		});

		it('does not drop a real VA resource list just because it opens with an external-link disclaimer sentence (tap_va_benefits_guide.json block 172, page 173)', () => {
			const result = classifyBlock({
				page: 173,
				text:
					'VA Benefits and Services Participant GuideA-160Version 6 1 September 2025 APPENDIX A: Additional Resources External Link Disclaimer: This document contains links that will take you outside of the Department of Veterans Affairs website VA does not endorse and is not responsible for the content of the linked websites VA Resources ' +
					BULLET +
					' myVA ' +
					BULLET +
					' Center for Women Veterans (CWV) ' +
					BULLET +
					' Center for Minority Veterans (CMV) ' +
					BULLET +
					' VA Benefits Hotline: Hearing Impaired (TTY): Dial 711, then 1-800-827-1000 ' +
					BULLET +
					' inTransition ' +
					BULLET +
					' National Guard and Reserve'
			});
			// This block is a genuine appendix of real resource links (myVA, veteran-specific
			// centers, a benefits hotline number) - it only OPENS with a short external-link
			// disclaimer sentence. That sentence uses different wording ("does not endorse and is
			// not responsible for") than the standalone DoD/VA disclaimer boilerplate ("does not
			// constitute a formal endorsement"), so it must not be mistaken for that dedicated
			// disclaimer block and dropped.
			expect(result.kind).toBe('content');
			expect(typeof result.confidence).toBe('number');
		});

		it('keeps a dotted-leader fill-in worksheet as content, not a marker-less toc (no page numbers to corroborate)', () => {
			// A budget worksheet uses dotted leaders as blank fill-in lines, so it clears the >= 9
			// dotted-leader bar - but unlike a real contents page its leaders lead to blanks, not page
			// numbers. Dotted-leader density alone would auto-drop this real government content; the
			// page-number corroboration keeps it.
			const result = classifyBlock({
				page: 40,
				text: 'MONTHLY SPENDING PLAN WORKSHEET Housing (rent or mortgage).......... Utilities.......... Groceries.......... Transportation.......... Health care.......... Childcare.......... Debt payments.......... Savings and TSP contributions.......... Insurance premiums.......... Entertainment and dining.......... Total monthly expenses..........'
			});
			expect(result.kind).toBe('content');
		});

		it('always returns a confidence within [0, 1], including for content', () => {
			const result = classifyBlock({ page: 4, text: FUSED_HEADER_CONTENT });
			expect(result.confidence).toBeGreaterThanOrEqual(0);
			expect(result.confidence).toBeLessThanOrEqual(1);
		});
	});
});
