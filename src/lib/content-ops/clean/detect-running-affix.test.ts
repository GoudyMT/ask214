import { describe, it, expect } from 'vitest';
import { detectRunningAffix } from './detect-running-affix';

// Every fixture text below is copied verbatim (then truncated at a safe, plain-ASCII cut point -
// the real blocks run longer and drift into a bullet or an em dash further in) from a real
// extracted PDF guide under content-ops/extracted/ (gitignored, so unreadable in CI - hence
// hardcoded here rather than read from disk).

// tap_managing_transition.json blocks 3-14 (pages 4-15, 12 blocks - the document's real block
// count is 27, so this clears MIN_BLOCKS_FOR_AFFIX on real data rather than a padded-out fixture):
// the extractor fused a "| 2026Managing Your (MY) Transition" running header onto the front of
// each page's content, trailed directly by that page's own page number with no separator.
const MANAGING_TRANSITION_BLOCKS = [
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

// tap_va_benefits_guide.json blocks 30-41 (pages 31-42, 12 blocks - the document's real block
// count is 217): the extractor fused BOTH a guide-name stamp and a version/date stamp onto the
// front of each page, with that page's own page number wedged directly between them (no separator
// on either side). Blocks 33-41 (9 of the 12) additionally share a "Module 2: Maintaining Your
// Health" chapter sub-header right after the version stamp - a real, second layer of repetition
// this fixture deliberately keeps in, so the test proves that sub-header does NOT get folded into
// the version/date segment despite outnumbering the dissenting blocks 11 to 1.
const VA_BENEFITS_BLOCKS = [
	{
		text: 'VA Benefits and Services Participant Guide18Version 6 1 September 2025Module 1: Introduction to Benefits and Services Self-Guided Activity: Update You',
		page: 31
	},
	{
		text: 'VA Benefits and Services Participant Guide19Version 6 1 September 2025MODULE 2 Maintaining Your Health MODULE 1 MODULE 2 MODULE 3 MODULE 4 MODULE 5 MO',
		page: 32
	},
	{
		text: 'VA Benefits and Services Participant Guide20Version 6 1 September 2025 In This Module ',
		page: 33
	},
	{
		text: 'VA Benefits and Services Participant Guide21Version 6 1 September 2025Module 2: Maintaining Your Health Whole Health starts with ME. Whole Health is V',
		page: 34
	},
	{
		text: 'VA Benefits and Services Participant Guide22Version 6 1 September 2025Module 2: Maintaining Your Health The Circle of Health Your physical, emotional ',
		page: 35
	},
	{
		text: 'VA Benefits and Services Participant Guide23Version 6 1 September 2025Module 2: Maintaining Your Health Get Started with Whole Health Your story is un',
		page: 36
	},
	{
		text: 'VA Benefits and Services Participant Guide24Version 6 1 September 2025Module 2: Maintaining Your Health You will discover what gives you a sense of me',
		page: 37
	},
	{
		text: 'VA Benefits and Services Participant Guide25Version 6 1 September 2025Module 2: Maintaining Your Health Use this circle to help you think about your w',
		page: 38
	},
	{
		text: 'VA Benefits and Services Participant Guide26Version 6 1 September 2025Module 2: Maintaining Your Health Where You Are and Where You Would Like to Be F',
		page: 39
	},
	{
		text: 'VA Benefits and Services Participant Guide27Version 6 1 September 2025Module 2: Maintaining Your Health Reflections Now that you have thought about wh',
		page: 40
	},
	{
		text: 'VA Benefits and Services Participant Guide28Version 6 1 September 2025Module 2: Maintaining Your Health Use the VA Facility Locator Visit the Find VA ',
		page: 41
	},
	{
		text: 'VA Benefits and Services Participant Guide29Version 6 1 September 2025Module 2: Maintaining Your Health What if I need care outside of the U.S.? If yo',
		page: 42
	}
];

// tap_va_home_loan.json blocks 0, 1 (its full 2-block document): a real small guide whose two
// blocks both open with the same long cover/title text - genuine shared content, not a repeated
// per-page header, since a 2-block document cannot have a "page" that repeats at all. Below the
// block-count floor, so this must NOT be treated as a learnable running affix even though the two
// blocks share a very long literal prefix.
const VA_HOME_LOAN_BLOCKS = [
	{
		text: 'Links page 1 VA Home Loan Guaranty Program Online Reference Guide Version 3.0 Released October 2020, Revised July 2025 VA Home Loan Guaranty Program MILITARY LIFE CYCLE ONLINE REFERENCE GUIDE The Transition Assistance Pr',
		page: 1
	},
	{
		text: 'Links page 2 VA Home Loan Guaranty Program Online Reference Guide Version 3.0 Released October 2020, Revised July 2025 VA HOME LOAN GUARANTY PROGRAM',
		page: 2
	}
];

// dod_skillbridge.json blocks 2, 4, 6: real HTML-extracted prose from unrelated sections of a
// clean source with no running header/footer at all - each block opens and closes differently.
const CLEAN_HTML_BLOCKS = [
	{
		text: 'The DOW SkillBridge program gives service members the chance to gain valuable civilian work experience. It offers specific industry training, apprenticeships or internships during the last 180 days of military service. The program connects service members with industry partners in real-world job experiences.',
		section: 'Overview'
	},
	{
		text: 'Many SkillBridge authorized partners also offer pathways to training and employment to veterans, National Guard, reserve and military spouses. These programs are not supported financially by DOW but may be offered on different terms than to other groups.',
		section: 'Overview'
	},
	{
		text: 'Visit the DOW SkillBridge website to learn more about program eligibility requirements, industry partners/employers, commands and installation offices, and SkillBridge locations.',
		section: 'How to Access This Website'
	}
];

describe('detectRunningAffix', () => {
	it('finds the trailing-page-number running header shared across blocks (tap_managing_transition.json blocks 3-14)', () => {
		const affix = detectRunningAffix(MANAGING_TRANSITION_BLOCKS);
		// Exact match (not just a substring check): proves the leading "| 2026" year stamp is
		// captured as part of the constant too, not dropped, and that the page number that
		// immediately follows (4 through 15) is excluded from the segment.
		expect(affix.prefix).toContain('| 2026Managing Your (MY) Transition');
	});

	it('has no footer for the trailing-page-number style (tap_managing_transition.json blocks 3-14)', () => {
		const affix = detectRunningAffix(MANAGING_TRANSITION_BLOCKS);
		expect(affix.suffix).toEqual([]);
	});

	it('finds both constant segments of the embedded-page-number running header, with the page number excluded from either (tap_va_benefits_guide.json blocks 30-41)', () => {
		const affix = detectRunningAffix(VA_BENEFITS_BLOCKS);
		// Exact match on both segments: proves the page number (18/19/20) wedged between them is
		// excluded, and that the "Module 1:"/"MODULE 2"/"In This Module" text that follows on most
		// (but not all) pages - a different, chapter-level recurring token, not a document-wide
		// constant - is NOT folded into the version/date segment.
		expect(affix.prefix).toHaveLength(2);
		expect(affix.prefix).toContain('VA Benefits and Services Participant Guide');
		expect(affix.prefix).toContain('Version 6 1 September 2025');
	});

	it('finds nothing below the block-count floor even when the few blocks share a long literal prefix (tap_va_home_loan.json, full 2-block document)', () => {
		// Without an absolute floor, these 2 blocks alone would clear the 50% fraction threshold
		// (1 of 2 is already "a majority") and the shared cover text would be misread as a running
		// header - which strip-fused would then delete from real content. A document this small has
		// no statistically meaningful running header to learn from in the first place.
		const affix = detectRunningAffix(VA_HOME_LOAN_BLOCKS);
		expect(affix.prefix).toEqual([]);
		expect(affix.suffix).toEqual([]);
	});

	it('finds nothing on a clean source with no repeated affix (dod_skillbridge.json blocks 2, 4, 6)', () => {
		const affix = detectRunningAffix(CLEAN_HTML_BLOCKS);
		expect(affix.prefix).toEqual([]);
		expect(affix.suffix).toEqual([]);
	});

	it('returns empty arrays for an empty block list', () => {
		expect(detectRunningAffix([])).toEqual({ prefix: [], suffix: [] });
	});
});
