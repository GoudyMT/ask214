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
