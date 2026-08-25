import {
	MAX_MESSAGE_LEN,
	MAX_EMAIL_LEN,
	sanitizeRoute,
	type FeedbackInput,
	type FeedbackValidation
} from './types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateFeedback(input: FeedbackInput): FeedbackValidation {
	if ((input.honeypot ?? '').trim() !== '') return { ok: false, reason: 'spam' };

	const message = (input.message ?? '').trim();
	if (message === '') return { ok: false, reason: 'empty' };
	if (message.length > MAX_MESSAGE_LEN) return { ok: false, reason: 'too_long' };

	let replyEmail: string | null = null;
	const rawEmail = (input.replyEmail ?? '').trim();
	if (rawEmail !== '') {
		const bad =
			rawEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(rawEmail) || /[\r\n]/.test(rawEmail);
		if (bad) return { ok: false, reason: 'bad_email' };
		replyEmail = rawEmail;
	}

	return { ok: true, value: { message, route: sanitizeRoute(input.route ?? null), replyEmail } };
}
