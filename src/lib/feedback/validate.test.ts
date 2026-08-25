import { describe, it, expect } from 'vitest';
import { validateFeedback } from './validate';

describe('validateFeedback', () => {
	it('rejects an empty / whitespace message', () => {
		expect(validateFeedback({ message: '' })).toEqual({ ok: false, reason: 'empty' });
		expect(validateFeedback({ message: '   ' })).toEqual({ ok: false, reason: 'empty' });
	});
	it('rejects an over-long message', () => {
		expect(validateFeedback({ message: 'x'.repeat(4001) })).toEqual({
			ok: false,
			reason: 'too_long'
		});
	});
	it('rejects a filled honeypot as spam', () => {
		expect(validateFeedback({ message: 'hi', honeypot: 'bot' })).toEqual({
			ok: false,
			reason: 'spam'
		});
	});
	it('accepts a valid message, trims it, defaults route + email to null', () => {
		const r = validateFeedback({ message: '  hello  ' });
		expect(r).toEqual({ ok: true, value: { message: 'hello', route: null, replyEmail: null } });
	});
	it('accepts + sanitizes an attached route', () => {
		const r = validateFeedback({ message: 'hi', route: '/timeline?x=1' });
		expect(r.ok && r.value.route).toBe('/timeline');
	});
	it('drops an unknown route to null (never trusts the client)', () => {
		const r = validateFeedback({ message: 'hi', route: '/evil' });
		expect(r.ok && r.value.route).toBeNull();
	});
	it('accepts a well-formed reply email', () => {
		const r = validateFeedback({ message: 'hi', replyEmail: 'a@b.co' });
		expect(r.ok && r.value.replyEmail).toBe('a@b.co');
	});
	it('rejects a malformed email or one with header-injection chars', () => {
		expect(validateFeedback({ message: 'hi', replyEmail: 'nope' })).toEqual({
			ok: false,
			reason: 'bad_email'
		});
		expect(validateFeedback({ message: 'hi', replyEmail: 'a@b.co\r\nBcc: x@y.z' })).toEqual({
			ok: false,
			reason: 'bad_email'
		});
	});
});
