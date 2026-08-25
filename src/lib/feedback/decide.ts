import { validateFeedback } from './validate';
import { composeFeedbackEmail, type FeedbackEmail } from './compose';
import type { FeedbackInput } from './types';

export type FeedbackDecision =
	{ kind: 'send'; email: FeedbackEmail } | { kind: 'reject' } | { kind: 'limited' };

export interface DecideDeps {
	/** True when the submission is within the per-IP + daily limits (backed by the DO in the shell). */
	checkLimit: () => Promise<boolean>;
}

/**
 * Orchestrates one feedback submission: parse -> validate -> rate-limit -> compose. Pure except the
 * injected checkLimit; the shell performs the actual email send on a 'send' decision. Garbage and
 * invalid input are rejected BEFORE the limit is consulted, so they never consume the send budget.
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
		...(typeof o.honeypot === 'string' ? { honeypot: o.honeypot } : {})
	};
}
