import { describe, it, expect } from 'vitest';
import { classifyBlock } from './classify-block';

// Every fixture text below is copied verbatim from a real extracted PDF guide under
// content-ops/extracted/ (gitignored, so unreadable in CI - hence hardcoded here rather than
// read from disk). Where the source PDF text contains a non-ASCII character, it is rebuilt with
// String.fromCharCode so this source file itself stays ASCII-only.
const EM_DASH = String.fromCharCode(0x2014); // U+2014 em dash, as extracted from the source PDF
const BULLET = String.fromCharCode(0x25a0); // U+25A0 black square, used as a list bullet in the source PDF
const ANGLE = String.fromCharCode(0x203a); // U+203A single right angle quote, a sub-entry bullet in the source PDF
const LEFT_QUOTE = String.fromCharCode(0x201c); // U+201C left double quote, as extracted from the source PDF
const RIGHT_QUOTE = String.fromCharCode(0x201d); // U+201D right double quote, as extracted from the source PDF
const APOSTROPHE = String.fromCharCode(0x2019); // U+2019 right single quote, used as an apostrophe in the source PDF

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

		it('classifies a marker-ed contents page whose page references are appendix-style, not plain numbers (tap_va_benefits_guide.json, page 12)', () => {
			// This real contents page lists appendix entries ("A-160", "A-161") in place of bare page
			// numbers, so the original bare-\d{1,3} page-number signal scored it near zero and kept it
			// as content. The widened signal counts appendix-style references as page references too, so
			// the contents page reads as the dense list of title-plus-reference entries it actually is.
			const result = classifyBlock({
				page: 12,
				text:
					'VA Benefits and Services Participant Guide Table of ContentsxiiVersion 6 1 September 2025 ' +
					'Appendix A: Additional Resources...................................A-160 VA Resources A-160 ' +
					'Applying for Disability Compensation A-160 ' +
					ANGLE +
					' Disability Compensation, Retired Pay, Separation Pay or Disability Severance Pay A-160 ' +
					'Burials and Memorials A-160 ' +
					ANGLE +
					' Monetary Benefits for Survivors: A-161 ' +
					ANGLE +
					' Dependency and Indemnity Compensation A-161 ' +
					ANGLE +
					' Survivors Pension A-161 Community Resources A-161 COVID-19 A-162 Dental Care A-162'
			});
			expect(result.kind).toBe('toc');
			expect(result.confidence).toBeGreaterThan(0.5);
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

	// A graded classroom exercise is the ONE class in this corpus where the app can state something
	// FALSE while quoting the source perfectly: a multiple-choice distractor is wrong by construction,
	// and a true/false statement bank is a list of claims the reader is meant to judge, not believe.
	// Measured over all 38 cleaned sources: 6 blocks carry an exercise marker that OPENS or titles the
	// block, across 3 guides. Every fixture below is verbatim from content-ops/cleaned/.
	describe('exercise', () => {
		it('drops a multiple-choice quiz block (tap_va_benefits_guide block 152, page 164)', () => {
			const result = classifyBlock({
				page: 164,
				text: `Module 6: Course Capstone Module Question Module 1 1. On which form, referred to as, ${LEFT_QUOTE}your key to most VA benefits and services,${RIGHT_QUOTE} should you confirm correct information before leaving active duty to ensure you have access to your benefits? a. VA Form 10-10164 b. DD214 c. VA Form SGLV-8600 d. NGB Form 22 Module 1 2. According to`
			});
			// Three of these four options are wrong by design. Rendered as an answer they read as the
			// document's own prose, because the word "quiz" appears nowhere in the block.
			expect(result.kind).toBe('exercise');
			expect(result.confidence).toBeGreaterThanOrEqual(0.7);
		});

		it('drops the answer-key table (tap_va_benefits_guide block 204, page 216)', () => {
			const result = classifyBlock({
				page: 216,
				text: 'B-203Version 6 1 September 2025Appendix B: Course Links Course Capstone Answer Key Module Question Number Answer PG Page Module 1 1 b. DD214 Page 12 Module 1 2 d. LES Page 13 Module 2 3 c. A and B Page 46 Module 2 4 d. There is no deadline Page 41 Module 2 5 b. Dial 988, then press 1 Page 57'
			});
			// Correct, but it renders as "Module 3 8 b. 180 to 90 days before separation Page 72" - a
			// grid of loose tokens that answers nothing.
			expect(result.kind).toBe('exercise');
			expect(result.confidence).toBeGreaterThanOrEqual(0.7);
		});

		it('drops a true/false statement bank whose marker OPENS the block (tap_dol_employment_workshop block 8, page 18)', () => {
			const result = classifyBlock({
				page: 18,
				text: `ACTIVITY 2.1: RESUME QUIZ Read each statement and decide whether it is true or false. 1. The number one rule for writing a good resume is ${LEFT_QUOTE}more is better.${RIGHT_QUOTE} 2. Regardless of your age, your resume work history should list all jobs going back to high school. 3. Your targeted resume should not be longer than two pages.`
			});
			// The most dangerous block measured. The chunker splits the "decide whether it is true or
			// false" frame off the statements, so the shipped answer renders 109 words of plain
			// declarative advice - including telling the reader to put their race, age and marital
			// status on a resume.
			expect(result.kind).toBe('exercise');
			expect(result.confidence).toBeGreaterThanOrEqual(0.7);
		});

		it('KEEPS a prose answer key, whose corrections are the only place the guidance exists (tap_dol_employment_workshop block 174, page 184)', () => {
			const result = classifyBlock({
				page: 184,
				text: `SECTION 8: APPENDICES APPENDIX A: RESUME QUIZ Answers to the Resume Quiz on Page 18. 1. The number one rule for writing a good resume is ${LEFT_QUOTE}more is better.${RIGHT_QUOTE} FALSE: An employer reviews a resume, on average, less than 30 seconds, so there is a very short amount of time to catch their attention.`
			});
			// Not a token grid: every item is a full paragraph of Department of Labor guidance, and five of
			// its corrections exist nowhere else in the corpus - how far back a work history should go, that
			// a paid resume writer will not save you time, and that age and marital status do not belong on
			// a resume. Dropping this block removed the document's own correction of the statement bank on
			// page 18 while leaving the hazard that bank describes unanswered.
			//
			// Keeping it is safe only because a chunk boundary cannot separate a statement from its verdict
			// - see the resolution guard in chunk/split.ts.
			expect(result.kind).toBe('content');
		});

		it('keeps a block that merely CITES an appendix whose title contains QUIZ', () => {
			// A cross-reference names the appendix; it is not the appendix. The corpus already carries this
			// sentence on the surviving RESUME BASICS page, so a rule matching the title anywhere in a block
			// would auto-drop a page of real guidance at full confidence, with no review lane to catch it.
			const result = classifyBlock({
				page: 17,
				text: 'RESUME BASICS A targeted resume is written for one specific job posting. Review the statements and decide whether each is true or false. Answers will be discussed in class and are available in Appendix A: Resume Quiz.'
			});
			expect(result.kind).toBe('content');
		});

		it('keeps prose that mentions a module question in a sentence', () => {
			// The anchor is the column header the guide prints above its question bank, not the two words
			// wherever they appear. A participant guide discusses its own modules constantly.
			const result = classifyBlock({
				page: 160,
				text: 'Module 6: Course Capstone This module reviews what you learned in Modules 1 through 5. If you have a Module Question that was not answered during the course, write it down and ask your Benefits Advisor before you leave.'
			});
			expect(result.kind).toBe('content');
		});

		// The hard constraint. A rule anchored on the word "Capstone" destroys 18 legitimate chunks,
		// including the passage below - which is the corpus's best answer to "what is Capstone and when
		// does it happen". Every anchor is a quiz FORM, so none of them can reach this text.
		it('keeps the passage that ANSWERS what a Capstone is (tap_pre_separation_brief, page 19)', () => {
			const result = classifyBlock({
				page: 19,
				text: 'Capstone and Warm Handovers After completing all required components of the ITP, you are required to attend a Capstone event which occurs no later than 90 days before transition or as soon as possible for Reserve Component members and Service members with unanticipated separations. During Capstone, the commander or a designee determines if you are prepared for transition.'
			});
			expect(result.kind).toBe('content');
		});

		it('keeps a worksheet ACTIVITY that is not a quiz (tap_moc_crosswalk, page 20)', () => {
			// 45 blocks across two guides open with an ACTIVITY header. They are worksheets, and their
			// "a. b. c." sub-lists are things to look up, not distractors - nothing in them is false.
			// Only the 2 labelled QUIZ are in scope here.
			const result = classifyBlock({
				page: 20,
				text: `ACTIVITY: Gap Analysis Left Column${EM_DASH}Experience I Have Now 1. Use the list of skills you created and your military and civilian documents for transition to locate the following information: 2. Complete the Left Column${EM_DASH}Experience I Have Now of the blank Gap Analysis located in the Appendix. a. Skills b. Education and Training c. Credentials (license, certification, certificate)`
			});
			expect(result.kind).toBe('content');
		});

		it('keeps a block whose exercise marker TRAILS it, leaving the run to the stripper (tap_dol_efct, page 123)', () => {
			// This block opens with real guidance on job offers and only turns into a quiz at the end.
			// Dropping it whole would destroy the guidance, so position is the discriminator: a marker
			// that opens the block condemns it, a marker that trails it does not.
			const result = classifyBlock({
				page: 123,
				text: `EFCT PARTICIPANT GUIDE | SECTION 7 | PAGE 123 JOB OFFERS Congratulations! You finished the final interview, and they offered you the job. Have you had an opportunity to see a written job offer? Let${APOSTROPHE}s start with what you already know about job offers and salary negotiation. JOB OFFER and SALARY NEGOTIATION QUIZ TRUE FALSE 1. A job offer will always be provided in writing. ACTIVITY 7.2: Job Offer Quiz Consider the 10 questions below. Mark each as True or False. What do you think?`
			});
			expect(result.kind).toBe('content');
		});

		it('drops a page-chrome widget that is the whole block', () => {
			expect(classifyBlock({ text: 'Was this page helpful?' }).kind).toBe('chrome');
			expect(classifyBlock({ text: 'Related Articles' }).kind).toBe('chrome');
			expect(classifyBlock({ text: 'Browse by topic' }).kind).toBe('chrome');
		});

		it('keeps a short heading or step that merely LOOKS like chrome', () => {
			// The enumeration that produced the literal list is the reason this rule matches a whole block
			// exactly rather than by length or by substring: of the 51 shortest chunks in this corpus, most
			// are real content - VGLI premium rows, application steps, and section headings.
			expect(classifyBlock({ text: 'Ages 30 to 34' }).kind).toBe('content');
			expect(classifyBlock({ text: 'Option 1: Apply online' }).kind).toBe('content');
			expect(classifyBlock({ text: 'Preferred providers' }).kind).toBe('content');
			expect(
				classifyBlock({ text: 'Related Articles cover how to transfer benefits to a dependent.' })
					.kind
			).toBe('content');
		});

		it('keeps prose about a real VA quiz a veteran can go and take (tap_va_womens_health, page 71)', () => {
			// "Quiz" as a plain noun in ordinary content. The Self-Check Quiz is a genuine VA resource,
			// so a rule keying on the word rather than the form would delete a mental-health referral.
			const result = classifyBlock({
				page: 71,
				text: 'Take a Free Self-Check VA and its partners have developed a quiz to help Veterans learn if stress and depression might be affecting them The Self-Check Quiz is a safe, easy and confidential resource'
			});
			expect(result.kind).toBe('content');
		});
	});
});
