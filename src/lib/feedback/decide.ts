import { validateFeedback } from './validate';
import { composeFeedbackEmail, type FeedbackEmail } from './compose';
import type { FeedbackInput } from './types';

export type FeedbackDecision =
	{ kind: 'send'; email: FeedbackEmail } | { kind: 'reject' } | { kind: 'limited' };

export interface DecideDeps {
	/** True when the submission is within the rate limit (the shell wires this to its rate-limiter). */
	checkLimit: () => Promise<boolean>;
}

/**
 * Orchestrates one feedback submission: parse -> validate -> compose. Pure except the injected
 * checkLimit; the shell handles rate-limiting and performs the email send on a 'send' decision.
 */
export async function decideFeedback(raw: unknown, deps: DecideDeps): Promise<FeedbackDecision> {
	const input = parseInput(raw);
	if (input === null) return { kind: 'reject' };

	const valid = validateFeedback(input);
	if (!valid.ok) return { kind: 'reject' };

	if (!(await deps.checkLimit())) return { kind: 'limited' };

	return { kind: 'send', email: composeFeedbackEmail(valid.value) };
}

function parseInput(raw: unknown): FeedbackInput | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const o = raw as Record<string, unknown>;
	const message = o.message;
	if (typeof message !== 'string') return null;
	return {
		message,
		route: typeof o.route === 'string' ? o.route : null,
		replyEmail: typeof o.replyEmail === 'string' ? o.replyEmail : null,
		// Coerce ANY present honeypot value to a string so a non-string (e.g. `honeypot: 1`) still
		// trips the spam check rather than being silently dropped.
		...(o.honeypot != null ? { honeypot: String(o.honeypot) } : {})
	};
}
