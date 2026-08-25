import { describe, it, expect } from 'vitest';
import { composeFeedbackEmail } from './compose';

describe('composeFeedbackEmail', () => {
	it('puts the message in the body and a fixed subject', () => {
		const e = composeFeedbackEmail({
			message: 'the ask page broke',
			route: null,
			replyEmail: null
		});
		expect(e.subject).toBe('Ask 214 feedback');
		expect(e.text).toContain('the ask page broke');
	});
	it('includes the attached page when present, notes absence otherwise', () => {
		expect(
			composeFeedbackEmail({ message: 'x', route: '/timeline', replyEmail: null }).text
		).toContain('Page: /timeline');
		expect(composeFeedbackEmail({ message: 'x', route: null, replyEmail: null }).text).toContain(
			'Page: (not shared)'
		);
	});
	it('sets replyTo from the email, or null', () => {
		expect(composeFeedbackEmail({ message: 'x', route: null, replyEmail: 'a@b.co' }).replyTo).toBe(
			'a@b.co'
		);
		expect(
			composeFeedbackEmail({ message: 'x', route: null, replyEmail: null }).replyTo
		).toBeNull();
	});
	it('never lets CR/LF into replyTo (header-injection defense)', () => {
		const e = composeFeedbackEmail({
			message: 'x',
			route: null,
			replyEmail: 'a@b.co\r\nBcc: y@z.co'
		});
		expect(e.replyTo).toBeNull();
	});
});
