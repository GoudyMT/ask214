import { describe, it, expect } from 'vitest';
import { stripFused } from './strip-fused';

describe('stripFused', () => {
	it('strips a trailing-page running header, leaving content verbatim', () => {
		expect(
			stripFused('| 2026Managing Your (MY) Transition4 Welcome to the course.', {
				prefix: ['| 2026Managing Your (MY) Transition'],
				suffix: []
			})
		).toBe('Welcome to the course.');
	});

	it('strips an embedded-page running header (two segments around the page number)', () => {
		expect(
			stripFused(
				'VA Benefits and Services Participant Guide18Version 6 1 September 2025Module 1: Introduction to Benefits and Services.',
				{
					prefix: ['VA Benefits and Services Participant Guide', 'Version 6 1 September 2025'],
					suffix: []
				}
			)
		).toBe('Module 1: Introduction to Benefits and Services.');
	});

	it('strips residual dotted-leader page references', () => {
		expect(
			stripFused('Module 2: Maintaining Your Health......20', { prefix: [], suffix: [] })
		).toBe('Module 2: Maintaining Your Health');
	});

	it('leaves a clean block untouched (byte-verbatim)', () => {
		const clean = 'You can apply for VA health care online or by phone.';
		expect(stripFused(clean, { prefix: [], suffix: [] })).toBe(clean);
	});

	it('leaves a block that does not start with the affix unchanged', () => {
		const t = 'A normal paragraph that never had a header fused to it.';
		expect(stripFused(t, { prefix: ['| 2026Managing Your (MY) Transition'], suffix: [] })).toBe(t);
	});

	it('strips a trailing footer segment (suffix)', () => {
		expect(
			stripFused('Real content here.SECTION 1 SECTION 2 SECTION 3', {
				prefix: [],
				suffix: ['SECTION 1 SECTION 2 SECTION 3']
			})
		).toBe('Real content here.');
	});

	// --- additional cases for full branch coverage ---

	it('stops at the first prefix segment not actually present, leaving the rest (including the never-matched segment text) untouched', () => {
		// Segment 0 present and stripped; segment 1 is not found immediately after it, so the loop
		// must stop there rather than assume the whole affix applies and hunt for segment 1 further in.
		expect(
			stripFused('Header One42Real content without the second header.', {
				prefix: ['Header One', 'Header Two'],
				suffix: []
			})
		).toBe('Real content without the second header.');
	});

	it('strips a variable run with a space on both sides of the page number', () => {
		expect(
			stripFused('Guide 18 VersionReal content.', { prefix: ['Guide', 'Version'], suffix: [] })
		).toBe('Real content.');
	});

	it('preserves legitimate interior digits after the header is removed (does not treat them as a page-number run)', () => {
		expect(
			stripFused(
				'| 2026Managing Your (MY) Transition6 Consider the following statistics: of those serving on active duty in 2021, 17% of them separate each year.',
				{ prefix: ['| 2026Managing Your (MY) Transition'], suffix: [] }
			)
		).toBe(
			'Consider the following statistics: of those serving on active duty in 2021, 17% of them separate each year.'
		);
	});

	it('leaves a block that does not end with the affix unchanged (suffix side of the partial-match stop)', () => {
		const t = 'Real content that ends normally with no footer at all.';
		expect(stripFused(t, { prefix: [], suffix: ['Footer Alpha', 'Footer Beta'] })).toBe(t);
	});

	it('stops at the first suffix segment (scanning end-inward) not actually present, leaving the rest untouched', () => {
		// Footer Beta is the tail-most segment and is present, so it is stripped; "NotPresent" (the
		// segment further from the true end) is checked next and is absent, so the walk stops there.
		expect(
			stripFused('Real content here.Footer Beta', {
				prefix: [],
				suffix: ['NotPresent', 'Footer Beta']
			})
		).toBe('Real content here.');
	});

	it('strips two footer segments end-inward with a variable run between them', () => {
		expect(
			stripFused('Real content here.Footer Alpha3Footer Beta', {
				prefix: [],
				suffix: ['Footer Alpha', 'Footer Beta']
			})
		).toBe('Real content here.');
	});

	it('strips both a prefix and a suffix from the same block', () => {
		expect(stripFused('HDR7Real content here.FTR', { prefix: ['HDR'], suffix: ['FTR'] })).toBe(
			'Real content here.'
		);
	});

	it('leaves a run of only 2 dots untouched (below the 3-dot leader threshold)', () => {
		const t = 'Section A..';
		expect(stripFused(t, { prefix: [], suffix: [] })).toBe(t);
	});

	it('strips a bare 3-dot leader with no trailing page number', () => {
		expect(stripFused('Section A...', { prefix: [], suffix: [] })).toBe('Section A');
	});

	it('drops a block that is nothing but a bare page-number stub once everything else is stripped', () => {
		expect(stripFused('42', { prefix: [], suffix: [] })).toBe('');
		expect(stripFused('  42  ', { prefix: [], suffix: [] })).toBe('');
	});

	it('does not treat a trailing number attached to real words as a bare page-number stub', () => {
		const t = 'Page 42';
		expect(stripFused(t, { prefix: [], suffix: [] })).toBe(t);
	});

	it('preserves a long numeric id glued to content immediately before a suffix affix (not a page-number run)', () => {
		// A running footer sits right after a content URL whose numeric id (6 digits) is glued to it.
		// The id is real government content, not a page number - stripping the footer must not eat it.
		const nav =
			'SECTION 1 SECTION 2 SECTION 3 SECTION 4 SECTION 5 SECTION 6 SECTION 7 SECTION 8 SECTION 9TOC';
		expect(
			stripFused(
				'Watch the course introduction video at https://www.dvidshub.net/ video/embed/936691 ' +
					nav,
				{ prefix: [], suffix: [nav] }
			)
		).toBe('Watch the course introduction video at https://www.dvidshub.net/ video/embed/936691');
	});

	it('preserves a 4-digit year glued to content before a suffix affix (too long to be a page number)', () => {
		expect(
			stripFused('members serving on active duty in 2021Footer Beta', {
				prefix: [],
				suffix: ['Footer Beta']
			})
		).toBe('members serving on active duty in 2021');
	});

	it('still strips a short (<=3 digit) page number between content and a suffix footer', () => {
		// The legitimate page-number case must keep working: a bare page number delimited from content.
		expect(
			stripFused('Real content here. 12 Footer Beta', { prefix: [], suffix: ['Footer Beta'] })
		).toBe('Real content here.');
	});

	it('strips a running header whose page number LEADS the constant text (leading-page shape)', () => {
		// Some guides print the page number before the header, so the constant segment does not start
		// at position 0; the leading page number must be skipped for the prefix segment to match.
		expect(
			stripFused('5Version 3 0 Womens Health Handbook Real content here.', {
				prefix: ['Version 3 0 Womens Health Handbook'],
				suffix: []
			})
		).toBe('Real content here.');
	});

	// --- fused module-navigation catalog (tap_va_womens_health) ---
	// The womens_health guide fuses a module/appendix nav catalog onto blocks: a run of back-to-back
	// "Module N"/"Appendix X" tokens glued together with no separator. It is a fixed junk literal, not
	// a learnable per-page header, so it is stripped by shape (>= 3 consecutive glued nav tokens),
	// independent of any learned affix.

	it('strips a trailing fused nav catalog, keeping the real content verbatim (womens_health acronyms table)', () => {
		expect(
			stripFused(
				'VA Acronym List * T stands for Trans-identifying Module 1 AcronymsModule 2Module 3Module 4Module 5Appendix AAppendix BAppendix C',
				{ prefix: [], suffix: [] }
			)
		).toBe('VA Acronym List * T stands for Trans-identifying');
	});

	it('strips the nav catalog off a module-divider block, leaving the section title (womens_health page 5)', () => {
		expect(
			stripFused(
				'Module 1: Shift From Active DutyModule 1Module 1 AcronymsModule 2Module 3Module 4Module 5Appendix AAppendix BAppendix C',
				{ prefix: [], suffix: [] }
			)
		).toBe('Module 1: Shift From Active Duty');
	});

	it('does NOT strip a real "Module N:" section header on genuine prose (no glued back-to-back run)', () => {
		// The benefits_guide has 81 real content chunks that legitimately open with "Module N: Title"
		// followed by prose. A single "Module 1:" is one token, not a >= 3 glued run, so it is kept.
		const t =
			'Module 1: Introduction to Benefits and Services Introduction No two transitions are the same.';
		expect(stripFused(t, { prefix: [], suffix: [] })).toBe(t);
	});

	it('does NOT strip a real prose list of module references separated by sentences', () => {
		// Real prose that mentions modules has spaces/sentence text between the tokens, so they are
		// never a glued run - the space-less concatenation is what marks the extraction-artifact catalog.
		const t = 'Module 2 covers health. Module 3 covers education. Module 4 covers employment.';
		expect(stripFused(t, { prefix: [], suffix: [] })).toBe(t);
	});

	// A second guide (tap_va_benefits_guide) fuses an ALL-CAPS module index ("MODULE 1 CHECKLIST
	// MODULE 2 MODULE 3 ... APPENDIX A APPENDIX B"), space-separated rather than glued. The all-caps
	// form is the safety discriminator here: real prose writes "Module 1", never a run of "MODULE"
	// tokens, so a run of >= 3 uppercase MODULE/APPENDIX/CHECKLIST tokens is unambiguously the index.

	it('strips an uppercase module-index nav strip, keeping the section title (benefits_guide format)', () => {
		expect(
			stripFused(
				'MODULE 1: Introduction to VA Benefits and Services MODULE 1 CHECKLIST MODULE 2 MODULE 3 MODULE 4 MODULE 5 MODULE 6 APPENDIX A APPENDIX B',
				{ prefix: [], suffix: [] }
			)
		).toBe('MODULE 1: Introduction to VA Benefits and Services');
	});

	it('strips an uppercase nav strip sitting between two real sentences, keeping both (benefits_guide page 2)', () => {
		expect(
			stripFused(
				'Select this arrow button to move to the next page. MODULE 1 MODULE 2 MODULE 3 MODULE 4 MODULE 5 MODULE 6 APPENDIX A APPENDIX B Disclaimer: Fillable content requires a compatible PDF reader.',
				{ prefix: [], suffix: [] }
			)
		).toBe(
			'Select this arrow button to move to the next page. Disclaimer: Fillable content requires a compatible PDF reader.'
		);
	});

	it('does NOT strip a lone uppercase "MODULE 1" heading on real content (no >= 3 token run)', () => {
		const t = 'MODULE 1 Introduction This module covers your benefits and services in detail.';
		expect(stripFused(t, { prefix: [], suffix: [] })).toBe(t);
	});

	it('keeps a 2-token nav run - one below the >= 3-token strip boundary (glued and uppercase)', () => {
		// The strip fires only on a run of THREE or more back-to-back nav tokens; a 2-token run is left
		// intact, so a fragment that merely abuts two module/appendix tokens is never eaten. Pins the
		// boundary: lowering the run requirement to two would strip these and fail here.
		expect(stripFused('Module 1Module 2 remains here.', { prefix: [], suffix: [] })).toBe(
			'Module 1Module 2 remains here.'
		);
		expect(stripFused('MODULE 1 MODULE 2 remains here.', { prefix: [], suffix: [] })).toBe(
			'MODULE 1 MODULE 2 remains here.'
		);
	});
});
