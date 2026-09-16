import { describe, expect, it } from 'vitest';
import { stripHeadingEcho } from './heading-echo';

describe('stripHeadingEcho', () => {
	it('drops a heading the extractor duplicated into the body', () => {
		expect(
			stripHeadingEcho('Your Intent to File Once you notify us...', 'Your Intent to File')
		).toBe('Once you notify us...');
	});

	it('drops the punctuation that joined the heading to the body', () => {
		expect(stripHeadingEcho('Eligibility: you may qualify...', 'Eligibility')).toBe(
			'you may qualify...'
		);
	});

	it('leaves text alone when there is no section', () => {
		expect(stripHeadingEcho('Some body text.', undefined)).toBe('Some body text.');
	});

	it('leaves text alone when the body does not start with the section', () => {
		expect(stripHeadingEcho('We require certain documents.', 'What documents')).toBe(
			'We require certain documents.'
		);
	});

	// The shipped strip is character-level, so a section that is a prefix of a longer opening word would cut
	// mid-word. No chunk in the corpus does this today; the guard is what keeps it that way.
	it('never cuts mid-word when the section is a prefix of a longer first word', () => {
		expect(stripHeadingEcho('Educational benefits are available.', 'Education')).toBe(
			'Educational benefits are available.'
		);
	});

	it('strips a heading that consumes the whole body', () => {
		expect(stripHeadingEcho('Overview', 'Overview')).toBe('');
	});

	// A heading that opens with "If" or "Unless" is not a label on the passage, it is the ANTECEDENT of the
	// sentence that follows. Removing it turns a conditional grant into an unconditional determination -
	// "You're eligible for VA health care" with no "if" - which is the one shape 38 CFR 14.629 forbids. The
	// text is true in the source and false on screen. 26 of the corpus's 353 echoed headings have this form.
	it('keeps a conditional heading, which governs the sentence after it', () => {
		expect(
			stripHeadingEcho(
				'If you served in certain locations and time periods during the Vietnam War era ' +
					"You're eligible for VA health care.",
				'If you served in certain locations and time periods during the Vietnam War era'
			)
		).toBe(
			'If you served in certain locations and time periods during the Vietnam War era ' +
				"You're eligible for VA health care."
		);
	});

	it('keeps an "Unless" heading for the same reason', () => {
		expect(
			stripHeadingEcho('Unless you are the spouse You can apply.', 'Unless you are the spouse')
		).toBe('Unless you are the spouse You can apply.');
	});

	// The guard keys on the conditional opener, not on the word appearing anywhere - a heading that merely
	// mentions a condition later still labels its passage rather than governing it.
	it('still strips a heading that only contains "if" mid-phrase', () => {
		expect(
			stripHeadingEcho('What to do if you move Update your address.', 'What to do if you move')
		).toBe('Update your address.');
	});
});
