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
});
