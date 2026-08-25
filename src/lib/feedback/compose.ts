import type { CleanFeedback } from './types';

export interface FeedbackEmail {
	subject: string;
	text: string;
	replyTo: string | null;
}

/** Compose the plain-text email the Worker sends to the inbox. Header-injection safe. */
export function composeFeedbackEmail(f: CleanFeedback): FeedbackEmail {
	const text = [
		f.message.trim(),
		'',
		f.route ? `Page: ${f.route}` : 'Page: (not shared)',
		f.replyEmail ? `Reply-to: ${f.replyEmail}` : 'Reply-to: (none)'
	].join('\n');
	const replyTo = f.replyEmail && !/[\r\n]/.test(f.replyEmail) ? f.replyEmail : null;
	return { subject: 'Ask 214 feedback', text, replyTo };
}
