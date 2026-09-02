import { describe, it, expect } from 'vitest';
import { quoteExcerpt, splitSentences } from './quote-excerpt';

describe('quoteExcerpt', () => {
	it('stops at a sentence boundary rather than mid-sentence', () => {
		const text = 'The first sentence is short. The second sentence would push it over the limit.';
		expect(quoteExcerpt(text, { target: 6 })).toBe('The first sentence is short.');
	});

	// The target budgets ACCUMULATION; the ceiling exists so a single sentence is not chopped to save a
	// few words. A broken quotation costs more trust than a slightly taller card.
	it('lets one sentence overflow the target to stay whole', () => {
		const thirtyFive =
			"Department of Labor's (DOL) Veterans' Employment and Training Service (VETS) administers programs designed to address the employment, training, and job security needs of over 200,000 military service members who transition to civilian life each year.";
		expect(quoteExcerpt(thirtyFive, { target: 30, ceiling: 45 })).toBe(thirtyFive);
	});

	it('does not let an optional second sentence overflow the target', () => {
		// Sentence one fits; adding sentence two would exceed the target. The ceiling rescues a single
		// sentence from truncation - it does not license extra optional content.
		const text =
			'An intent to file lets you notify VA that you plan to file a claim soon. It also sets an effective date for the benefits you may later receive from VA.';
		expect(quoteExcerpt(text, { target: 20, ceiling: 45 })).toBe(
			'An intent to file lets you notify VA that you plan to file a claim soon.'
		);
	});

	// A printed URL is real document content, so it is never deleted from a quotation - but it occupies
	// space out of all proportion to its single "word". Measured on this corpus: URL-bearing quotes ran
	// to 641 characters against a 358 maximum elsewhere. Budgeting by length keeps the card honest AND
	// bounded; the ellipsis marks that the passage was shortened.
	it('charges an over-long token against the budget by its length, not as one word', () => {
		const url = 'https://example.gov/' + 'a'.repeat(200);
		const text = `Visit ${url} today.`;
		// Three plain words would trivially fit a 15-word budget; its rendered length must not.
		const out = quoteExcerpt(text, { target: 15 });
		expect(out.endsWith('...')).toBe(true);
		expect(out).not.toContain(url);
	});

	it('truncates BEFORE an over-long token rather than slicing through it', () => {
		const url = 'https://example.gov/' + 'b'.repeat(200);
		const out = quoteExcerpt(`Read the guidance at ${url} before you apply.`, { target: 15 });
		// A sliced URL is both unreadable and misleading about what the document says.
		expect(out).toBe('Read the guidance at...');
	});

	it('leaves a short URL inside the quote untouched', () => {
		const text = 'Visit https://mypay.dfas.mil to sign in and review your statement.';
		expect(quoteExcerpt(text, { target: 30 })).toBe(text);
	});

	it('truncates at the target when even the ceiling cannot hold the sentence', () => {
		const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
		const result = quoteExcerpt(long, { target: 10, ceiling: 20 });
		expect(result.endsWith('...')).toBe(true);
		expect(result.split(/\s+/).length).toBe(10);
	});

	// Real corpus text (tap_financial_planning p.6) after cleanExcerpt, which converts PDF bullet
	// glyphs to " - " separators. A list trailing a sentence must not be absorbed into it - that is
	// exactly the run-on the quoted lead exists to stop showing.
	it('ends the quote before a converted bullet list', () => {
		const cleaned =
			'By accessing your LES or payslip, you will be able to apply what you are learning to your own situation. - MyPay Website - https://mypay.dfas.mil/#/ - CG Payslip - https://dcms.uscg.mil';
		expect(quoteExcerpt(cleaned, { target: 30 })).toBe(
			'By accessing your LES or payslip, you will be able to apply what you are learning to your own situation.'
		);
	});

	it('returns the whole text when it is prose that already fits', () => {
		const text = 'Short enough to keep. And a second one.';
		expect(quoteExcerpt(text, { target: 30 })).toBe(text);
	});

	it('marks the cut with an ellipsis when even the first sentence exceeds the budget', () => {
		const text = 'This single sentence runs well past the budget and cannot be kept whole at all.';
		expect(quoteExcerpt(text, { target: 6 })).toBe('This single sentence runs well past...');
	});

	it('returns an empty string for empty or whitespace-only input', () => {
		expect(quoteExcerpt('', { target: 30 })).toBe('');
		expect(quoteExcerpt('   ', { target: 30 })).toBe('');
	});

	// Real corpus shapes (mos_separation, dod_skillbridge): some chunks are bare section headers, and
	// quoting one word as if it were a passage from the document is worse than showing no quote. The
	// card falls back to source + page when this returns empty.
	it('returns empty when the quotable content is below the minimum', () => {
		expect(quoteExcerpt('Benefits', { target: 30, min: 5 })).toBe('');
		expect(quoteExcerpt('DOW SkillBridge', { target: 30, min: 5 })).toBe('');
	});

	it('keeps a quote that meets the minimum', () => {
		const text =
			'Overview The DOW SkillBridge program gives service members civilian work experience.';
		expect(quoteExcerpt(text, { target: 30, min: 5 })).toBe(text);
	});

	it('treats the minimum as optional so existing callers are unaffected', () => {
		expect(quoteExcerpt('Benefits', { target: 30 })).toBe('Benefits');
	});

	// Real corpus shape (tap_dol_efct): a short header followed by a BULLETED PARAGRAPH. Stopping at
	// the bullet would leave "Did You Know?" - below the minimum - and suppress a card whose real
	// content sits in the next segment. The list break must only apply once there is enough prose to
	// stand on its own.
	it('reads past a short header into the following segment for substance', () => {
		const cleaned =
			'Did You Know? - In a survey of professionals, 54 percent said they did not negotiate their most recent offer.';
		expect(quoteExcerpt(cleaned, { target: 30, min: 5 })).toBe(
			'Did You Know? In a survey of professionals, 54 percent said they did not negotiate their most recent offer.'
		);
	});

	it('still stops at the list once the prose already stands alone', () => {
		const cleaned =
			'By accessing your LES or payslip, you will be able to apply what you are learning to your own situation. - MyPay Website - https://mypay.dfas.mil/#/';
		expect(quoteExcerpt(cleaned, { target: 30, min: 5 })).toBe(
			'By accessing your LES or payslip, you will be able to apply what you are learning to your own situation.'
		);
	});
});

describe('splitSentences', () => {
	// Real corpus text (dol_tap_overview). A statute citation must not split into "...under 10 U." -
	// the abbreviation guard is what keeps a quotation from ending on a fragment.
	it('does not split inside a dotted statute abbreviation', () => {
		const text =
			'The Transition Assistance Program (TAP), provided under 10 U.S.C. 1144, is a cooperative interagency effort. It spans several agencies.';
		expect(splitSentences(text)).toEqual([
			'The Transition Assistance Program (TAP), provided under 10 U.S.C. 1144, is a cooperative interagency effort.',
			'It spans several agencies.'
		]);
	});

	// Real corpus shapes: a regulation cite and an occupation code both carry interior periods.
	it('does not split inside decimal reference numbers', () => {
		expect(
			splitSentences('Accreditation is governed by 38 CFR 14.629 for representatives.')
		).toEqual(['Accreditation is governed by 38 CFR 14.629 for representatives.']);
		expect(
			splitSentences('Avionics Technician (DOT 823.261-026) is a related occupation.')
		).toEqual(['Avionics Technician (DOT 823.261-026) is a related occupation.']);
	});

	it('does not split inside a URL', () => {
		expect(splitSentences('Visit https://mypay.dfas.mil to sign in.')).toEqual([
			'Visit https://mypay.dfas.mil to sign in.'
		]);
	});

	it('returns a single element when there is no sentence boundary', () => {
		expect(splitSentences('No terminal punctuation here')).toEqual([
			'No terminal punctuation here'
		]);
	});
});
