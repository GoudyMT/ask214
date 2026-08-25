import { describe, it, expect, vi } from 'vitest';
import { decideFeedback } from './decide';

const allow = () => Promise.resolve(true);
const over = () => Promise.resolve(false);

describe('decideFeedback', () => {
	it('rejects malformed / non-object input without checking the limit', async () => {
		const checkLimit = vi.fn(allow);
		expect((await decideFeedback(null, { checkLimit })).kind).toBe('reject');
		expect((await decideFeedback('nope', { checkLimit })).kind).toBe('reject');
		expect((await decideFeedback({}, { checkLimit })).kind).toBe('reject'); // no message
		expect(checkLimit).not.toHaveBeenCalled();
	});

	it('rejects an invalid message before the limit + send', async () => {
		const checkLimit = vi.fn(allow);
		expect((await decideFeedback({ message: '   ' }, { checkLimit })).kind).toBe('reject');
		expect(checkLimit).not.toHaveBeenCalled();
	});

	it('returns limited (no email) when the limiter is over', async () => {
		expect((await decideFeedback({ message: 'hi' }, { checkLimit: over })).kind).toBe('limited');
	});

	it('sends a composed email for a valid, under-limit submission', async () => {
		const d = await decideFeedback(
			{ message: 'the ask page broke', route: '/timeline', replyEmail: 'a@b.co' },
			{ checkLimit: allow }
		);
		expect(d.kind).toBe('send');
		if (d.kind === 'send') {
			expect(d.email.subject).toBe('Ask 214 feedback');
			expect(d.email.text).toContain('the ask page broke');
			expect(d.email.text).toContain('Page: Timeline');
			expect(d.email.replyTo).toBe('a@b.co');
		}
	});

	it('drops an unknown route to (not shared) via validation', async () => {
		const d = await decideFeedback({ message: 'hi', route: '/evil' }, { checkLimit: allow });
		expect(d.kind).toBe('send');
		if (d.kind === 'send') expect(d.email.text).toContain('Page: (not shared)');
	});

	it('rejects a filled honeypot, including a non-string value', async () => {
		expect(
			(await decideFeedback({ message: 'hi', honeypot: 'bot' }, { checkLimit: allow })).kind
		).toBe('reject');
		expect((await decideFeedback({ message: 'hi', honeypot: 1 }, { checkLimit: allow })).kind).toBe(
			'reject'
		);
	});
});
