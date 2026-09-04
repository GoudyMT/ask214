import { describe, it, expect } from 'vitest';
import { cleanExcerpt } from './clean-excerpt';
import { normalizeText } from './normalize';

// Non-ASCII glyphs are built from code points so this source stays pure ASCII (project standard) and
// the editing tools cannot mangle a literal.
const SQUARE = String.fromCodePoint(0x25a0); // black square list bullet
const BULLET = String.fromCodePoint(0x2022); // bullet dot
const GUILLEMET = String.fromCodePoint(0x00bb); // right guillemet used as a breadcrumb separator
const DINGBAT = String.fromCodePoint(0x277a); // dingbat negative-circled digit five, an ordered-list bullet
const MINUS = String.fromCodePoint(0x2212); // minus sign - this corpus uses it only as a bullet/separator
const PUA = String.fromCodePoint(0xf0a7); // Wingdings Private-Use-Area bullet (renders as tofu)
const SURROGATE = String.fromCodePoint(0x110bb); // broken supplementary-plane glyph
const ENDASH = String.fromCodePoint(0x2013);
const SECTION = String.fromCodePoint(0x00a7); // legal section sign - meaningful, must survive
const EACUTE = String.fromCodePoint(0x00e9); // accented e - meaningful, must survive
const THREEQ = String.fromCodePoint(0x00be); // fraction three-quarters - meaningful, must survive

describe('cleanExcerpt', () => {
	it('removes a leading list marker', () => {
		expect(cleanExcerpt(SQUARE + ' Summaries of VA Benefits')).toBe('Summaries of VA Benefits');
	});

	it('converts inline markers to " - " separators', () => {
		expect(
			cleanExcerpt('myVA ' + SQUARE + ' Center for Women ' + BULLET + ' Center for Minority')
		).toBe('myVA - Center for Women - Center for Minority');
	});

	it('converts a right-guillemet breadcrumb separator to " - "', () => {
		expect(cleanExcerpt('In this module ' + GUILLEMET + ' VA Benefits and Services')).toBe(
			'In this module - VA Benefits and Services'
		);
	});

	it('converts a dingbat circled-number list bullet to " - "', () => {
		expect(cleanExcerpt('LOAN GUARANTY PROGRAM ' + DINGBAT + ' VA Housing Assistance')).toBe(
			'LOAN GUARANTY PROGRAM - VA Housing Assistance'
		);
	});

	it('converts the minus-sign bullet/separator this corpus uses to " - "', () => {
		expect(cleanExcerpt('Excel, Outlook ' + MINUS + ' work independently ' + MINUS + ' team')).toBe(
			'Excel, Outlook - work independently - team'
		);
	});

	// Real corpus shape (tap_dol_efct, 155 occurrences): a pipe-delimited running page header the PDF
	// prints on every page, which extraction fuses into the body text.
	it('strips a pipe-delimited running page header', () => {
		expect(
			cleanExcerpt('EFCT PARTICIPANT GUIDE | SECTION 1 | PAGE 14 ACTIVITY 1.1: Introductions')
		).toBe('ACTIVITY 1.1: Introductions');
	});

	// The sibling DOL guide prints the SAME running header without the PAGE keyword
	// ("EMPLOYMENT WORKSHOP | SECTION 1 | 11"). Anchoring on PAGE alone left 215 of 370 occurrences in
	// the corpus, several of them visible inside rendered excerpts.
	it('strips the running header variant that omits the PAGE keyword', () => {
		expect(cleanExcerpt('EMPLOYMENT WORKSHOP | SECTION 1 | 11 FOCUS OF EACH SECTION')).toBe(
			'FOCUS OF EACH SECTION'
		);
	});

	it('strips the running header when the page number is cut off at a chunk boundary', () => {
		expect(cleanExcerpt('Develop Your Brand EFCT PARTICIPANT GUIDE | SECTION 4 | PAGE')).toBe(
			'Develop Your Brand'
		);
	});

	it('keeps a mixed-case section heading that precedes a running header', () => {
		expect(
			cleanExcerpt('Getting Started EFCT PARTICIPANT GUIDE | SECTION 1 | PAGE 8 Take a few minutes')
		).toBe('Getting Started Take a few minutes');
	});

	// This guide prints its headings in ALL CAPS, so an unbounded caps prefix swallowed real content -
	// the same content-destruction class a prior sweep caught shipped. The title match is bounded to at
	// most three caps words so the heading before it survives.
	it('keeps an ALL-CAPS section heading that precedes a running header', () => {
		expect(
			cleanExcerpt('GAINING MORE SKILLS EFCT PARTICIPANT GUIDE | SECTION 3 | PAGE 52 Consider this')
		).toBe('GAINING MORE SKILLS Consider this');
		expect(
			cleanExcerpt('NOTES EFCT PARTICIPANT GUIDE | SECTION 2 | PAGE 30 Write your answers')
		).toBe('NOTES Write your answers');
	});

	// The two guide titles are different LENGTHS (three words and two), so a word-COUNT bound cannot fit
	// both: bounding the run at three leaves a free slot in front of the two-word title, which then eats
	// the last token of real content. These four are the real corpus strings that lost a token
	// (tap_dol_employment_workshop chunks 98652df98874 / b2553578f3e5 / 662b136cde5e / 187a7a97bf3d).
	it('keeps the token in front of the two-word running header title', () => {
		expect(cleanExcerpt('Expires December 20XX EMPLOYMENT WORKSHOP | SECTION 2 | 54')).toBe(
			'Expires December 20XX'
		);
		expect(
			cleanExcerpt('Howard Community College, Baltimore, MD EMPLOYMENT WORKSHOP | SECTION 8 | 193')
		).toBe('Howard Community College, Baltimore, MD');
		expect(
			cleanExcerpt('Best Regards, Andrew Thompson II EMPLOYMENT WORKSHOP | SECTION 8 | 194')
		).toBe('Best Regards, Andrew Thompson II');
		expect(
			cleanExcerpt('APPLY TO JOB EMPLOYMENT WORKSHOP | SECTION 2 | 19 You will not provide')
		).toBe('APPLY TO JOB You will not provide');
	});

	// A caps run can also start mid-token, because the title match is preceded by a zero-width-able \s*.
	it('does not start the header match inside a preceding word', () => {
		expect(cleanExcerpt('DISCHARGE EMPLOYMENT WORKSHOP | SECTION 1 | 7 next')).toBe(
			'DISCHARGE next'
		);
	});

	// PAGE with no digits after it is the chunk-boundary form, so the keyword must still end on a word
	// boundary - otherwise a word merely starting with "PAGE" loses its tail.
	it('does not truncate a word that merely starts with PAGE', () => {
		expect(cleanExcerpt('EFCT PARTICIPANT GUIDE | SECTION 2 | PAGEANT winners')).toBe(
			'PAGEANT winners'
		);
	});

	it('leaves a pipe used as ordinary punctuation alone', () => {
		expect(cleanExcerpt('Choose one | two | three from the list')).toBe(
			'Choose one | two | three from the list'
		);
	});

	// Real corpus shape (tap_dol_efct): worksheet fill-in-the-blank rules extract as underscore runs,
	// which carry no content and read as corruption in a quoted excerpt.
	it('deletes worksheet blank-line underscore runs', () => {
		expect(cleanExcerpt('My current job in the military is ______________________ 2.')).toBe(
			'My current job in the military is 2.'
		);
	});

	it('leaves a short underscore inside a token alone', () => {
		expect(cleanExcerpt('the field source_id is required')).toBe('the field source_id is required');
	});

	// Real corpus shape (tap_va_benefits_guide, 136 occurrences): a "Module N:" running header that
	// extraction fuses into the body at a page break as well as at a chunk start. Every fixture below is
	// a real corpus string, addressed by chunk id - an earlier version of these tests invented fixtures
	// and got the corpus wrong (it paired Course Capstone with Module 4; it is Module 6).
	it('strips the Module running header at the start of a chunk', () => {
		expect(
			cleanExcerpt(
				'Module 1: Introduction to Benefits and Services Introduction No two transitions'
			)
		).toBe('Introduction No two transitions');
	});

	// tap_va_benefits_guide:ced8134cefca
	it('strips the Module running header where a page break fused it mid-text', () => {
		expect(
			cleanExcerpt(
				'Servicemember Affairs webpage or scan the QR code Module 5: Finding a Place to Live and Community Resources Housing Assistance'
			)
		).toBe('Servicemember Affairs webpage or scan the QR code Housing Assistance');
	});

	// The Module 5 title CONTAINS the Module 5 title of an earlier draft ("Finding a Place to Live"),
	// which matched first and left "and Community Resources" fused into the following prose across 17
	// chunks. The titles are sorted longest-first so a prefix can never win the alternation; this test
	// fails if that sort is removed or a truncated title is added.
	it('strips the whole Module title, never a prefix of it', () => {
		const out = cleanExcerpt(
			'Module 5: Finding a Place to Live and Community Resources Consider the following questions'
		);
		expect(out).toBe('Consider the following questions');
		expect(out).not.toContain('and Community Resources');
	});

	// 92 real prose references use "Module N" with NO colon. The colon is the whole safety margin.
	it('leaves a prose reference to a module untouched', () => {
		expect(
			cleanExcerpt('Upon completion of Module 1, you will be able to: Identify key factors')
		).toBe('Upon completion of Module 1, you will be able to: Identify key factors');
		expect(cleanExcerpt('Lunch occurs after Module 3, approximately halfway through the day')).toBe(
			'Lunch occurs after Module 3, approximately halfway through the day'
		);
	});

	// tap_va_benefits_guide:250a981c6448 - upper-case MODULE is the guide's TITLE PAGE, and it carries a
	// different title ("Introduction to VA Benefits and Services"). Matching case-insensitively would
	// delete real title-page content.
	it('leaves the upper-case MODULE title page alone', () => {
		expect(cleanExcerpt('MODULE 1: Introduction to VA Benefits and Services Welcome')).toBe(
			'MODULE 1: Introduction to VA Benefits and Services Welcome'
		);
	});

	// tap_va_womens_health:44992bc64063 - a different guide's contents listing, not a running header.
	// An unlisted title must keep its header visible rather than lose the words around it.
	it('leaves a Module header whose title is not listed alone', () => {
		expect(
			cleanExcerpt(
				'postseparation from the military: Module 1: Shift From Active Duty Shifting from'
			)
		).toBe('postseparation from the military: Module 1: Shift From Active Duty Shifting from');
	});

	// Real corpus shape (29 occurrences): the front-matter page token, glued to the guide title with no
	// space ("page 1Mental Health...") or standing alone at the opening ("page 1 Other Than Honorable").
	it('strips a front-matter page token glued to the guide title', () => {
		expect(
			cleanExcerpt('page 1Mental Health for Families MLC Online Resource Guide Mental Health')
		).toBe('Mental Health for Families MLC Online Resource Guide Mental Health');
	});

	it('strips a bare leading front-matter page token', () => {
		expect(
			cleanExcerpt('page 1 Other Than Honorable MILITARY LIFE CYCLE ONLINE RESOURCE GUIDE')
		).toBe('Other Than Honorable MILITARY LIFE CYCLE ONLINE RESOURCE GUIDE');
	});

	// tap_va_education_benefits:d3dc57093588 - 4 of the 29 sit MID-TEXT, fused at a page break, so the
	// glued alternative is deliberately not anchored to the string start. Both positive fixtures above
	// sit at index 0, which is exactly the blind spot that has to be covered explicitly.
	it('strips a front-matter page token fused mid-text', () => {
		expect(cleanExcerpt('Courses page 6VA Education Benefits Online Resource Guide')).toBe(
			'Courses VA Education Benefits Online Resource Guide'
		);
	});

	// "Resource Guide" is the name of a REAL document, cited 78 times across 62 chunks, mostly in
	// ordinary sentences. Only the page token is furniture; the name itself must survive.
	it('leaves a prose reference to the Resource Guide untouched', () => {
		expect(
			cleanExcerpt('The VETS Resource Guide (PDF) contains links to access many online resources')
		).toBe('The VETS Resource Guide (PDF) contains links to access many online resources');
		expect(cleanExcerpt('This Online Resource Guide (ORG) provides you with the web links')).toBe(
			'This Online Resource Guide (ORG) provides you with the web links'
		);
	});

	it('leaves a page number used in prose alone', () => {
		expect(cleanExcerpt('The checklist is continued on page 5 of the handbook')).toBe(
			'The checklist is continued on page 5 of the handbook'
		);
	});

	// Real corpus shape: a Symbol/Wingdings sub-bullet the extractor reduced to a bare letter - 141 of
	// the 158 standalone lowercase y/o. They separate list items, so they become the same " - " the
	// other marker glyphs do.
	it('converts the bare-letter bullet glyphs into separators', () => {
		expect(cleanExcerpt('Links y 38 CFR 3.12 VA Benefits y VA Mental Health Services')).toBe(
			'Links - 38 CFR 3.12 VA Benefits - VA Mental Health Services'
		);
		expect(cleanExcerpt('work experience, including: o Employer name o Job title')).toBe(
			'work experience, including: - Employer name - Job title'
		);
	});

	// tap_va_benefits_guide:ffbb1fc68cf9 - the Whole Health diagram labels extract letter-spaced, every
	// letter its own token. A bare y/o rule fires INSIDE these words: "Community" became
	// "C - m m u n i t -" on 17 real occurrences. A bullet always sits between multi-character tokens;
	// a tracked-out letter never does, which is what the neighbour constraint keys on.
	it('leaves letter-spaced text alone', () => {
		expect(cleanExcerpt('webpage A w a r e n e s s M i n d f u l C o m m u n i t y')).toBe(
			'webpage A w a r e n e s s M i n d f u l C o m m u n i t y'
		);
	});

	// Only y and o. The other single letters in this corpus are multiple-choice answer options
	// ("...Facilities d Community Living Centers e All of these"), which are real content.
	it('leaves single letters used as multiple-choice options alone', () => {
		expect(cleanExcerpt('c Vet Centers d Community Living Centers e All of these')).toBe(
			'c Vet Centers d Community Living Centers e All of these'
		);
	});

	it('deletes font-encoding garbage (Private-Use-Area tofu + broken surrogate)', () => {
		expect(cleanExcerpt('form ' + PUA + ' and ' + SURROGATE + ' submit')).toBe('form and submit');
	});

	it('deletes C0 control-code runs (a decorative glyph strip the extractor dropped to control codes)', () => {
		const controls = [0x1f, 0x1e, 0x1d, 0x1c, 0x1b, 0x08]
			.map((cp) => String.fromCodePoint(cp))
			.join(' ');
		expect(cleanExcerpt('Whole Health System ' + controls + ' Benefits')).toBe(
			'Whole Health System Benefits'
		);
	});

	it('strips an appendix version footer glued to a letter-hyphen page token', () => {
		expect(cleanExcerpt('A-160Version 6 1 September 2025 APPENDIX A: Additional Resources')).toBe(
			'APPENDIX A: Additional Resources'
		);
	});

	it('strips a roman-numeral version footer with an inner "Released" word', () => {
		expect(cleanExcerpt('viiiVersion 3 0 Released July 2025 Womens Health Handbook')).toBe(
			'Womens Health Handbook'
		);
	});

	it('strips the dot-format version footer (Version 6.1 ...) and its Released variant', () => {
		expect(cleanExcerpt('Benefits and Services Version 6.1 September 2025 MODULE 1: Intro')).toBe(
			'Benefits and Services MODULE 1: Intro'
		);
		expect(cleanExcerpt('Version 1.1 Released September 2025 Other Than Honorable Discharge')).toBe(
			'Other Than Honorable Discharge'
		);
	});

	it('strips the "Version X.Y Revised <Month> <Year>" footer the real corpus uses', () => {
		expect(
			cleanExcerpt('Online Resource Guide Version 1.0 Revised May 2025 VA Education Benefits')
		).toBe('Online Resource Guide VA Education Benefits');
	});

	it('strips a three-part version footer with chained Released + Revised dates', () => {
		expect(
			cleanExcerpt(
				'Career Resource Guide Version 3.0.1 Released March 2024, Revised July 2025 Links RESOURCE'
			)
		).toBe('Career Resource Guide Links RESOURCE');
	});

	it('strips the "Version X.Y Revised <date> for release <date>" footer, incl. a broken month', () => {
		expect(
			cleanExcerpt('Resource Guide Version 2.0 Revised May 2024 for release January 2025 CONTENT')
		).toBe('Resource Guide CONTENT');
		expect(
			cleanExcerpt(
				'Resource Guide page Version 2.0 Revised May 2024 for release J anuary 2025 CONTENT'
			)
		).toBe('Resource Guide page CONTENT');
	});

	it('strips a bare ", Revised <Month> <Year>" running-header footer that has no Version token', () => {
		expect(
			cleanExcerpt('Benefits 101 Online Resource Guide , Revised May 2025 ONLINE RESOURCE')
		).toBe('Benefits 101 Online Resource Guide ONLINE RESOURCE');
	});

	it('does NOT eat a real "Revised <year>" citation that lacks a month', () => {
		const t = 'Program Assessment (PSTAP) Revised 2021 Cross-sectional Survey of members.';
		expect(cleanExcerpt(t)).toBe(t);
	});

	it('cleans a chunk carrying BOTH a version footer and inline bullets (the real appendix card)', () => {
		expect(
			cleanExcerpt(
				'A-160Version 6 1 September 2025 APPENDIX A: Additional Resources VA Resources ' +
					SQUARE +
					' myVA ' +
					SQUARE +
					' Center for Women Veterans'
			)
		).toBe('APPENDIX A: Additional Resources VA Resources - myVA - Center for Women Veterans');
	});

	it('preserves meaningful symbols: the section sign, an accent, and a fraction', () => {
		const section = 'benefits under 38 U.S.C. ' + SECTION + ' 1151 apply';
		expect(cleanExcerpt(section)).toBe(section);
		const accent = 'avoid using clich' + EACUTE + ' phrases';
		expect(cleanExcerpt(accent)).toBe(accent);
		const frac = 'Enrolled at least ' + THREEQ + ' time in the program';
		expect(cleanExcerpt(frac)).toBe(frac);
	});

	it('leaves clean prose byte-verbatim', () => {
		const t = 'You can apply for VA health care online or by phone.';
		expect(cleanExcerpt(t)).toBe(t);
	});

	it('does NOT touch a real ASCII hyphen, en dash, or a bare "Version 6" mention in prose', () => {
		const t = 'Post-9/11 GI Bill ' + ENDASH + ' see Version 6 of the guide for details.';
		expect(cleanExcerpt(t)).toBe(t);
	});

	it('is a DISPLAY-ONLY transform, distinct from the anchor-space normalizeText (contract guard)', () => {
		const footer = 'A-160Version 6 1 September 2025 APPENDIX A: Additional Resources';
		// cleanExcerpt strips the fused footer for display; normalizeText (the anchor space) must NOT - it
		// only does NFC/ligature/zero-width/de-hyphen/whitespace, so anchors still resolve on the raw text.
		expect(cleanExcerpt(footer)).not.toBe(normalizeText(footer));
		expect(normalizeText(footer)).toContain('Version 6 1');
		expect(cleanExcerpt(footer)).not.toContain('Version');
	});
});
