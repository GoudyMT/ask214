import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { decideFeedback } from '$lib/feedback/decide';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export const POST: RequestHandler = async ({ request, platform, getClientAddress }) => {
	const env = platform?.env;
	// The key + destination + sender are deployment config (a secret + vars); never committed. All
	// three are required - no default sender (Resend's shared test sender won't reach an arbitrary To).
	if (!env?.RESEND_API_KEY || !env.FEEDBACK_TO || !env.FEEDBACK_FROM) {
		return json({ ok: false }, { status: 500 });
	}

	// Per-IP rapid-fire limit (atomic edge binding). Resend's free-tier daily quota bounds total sends;
	// a sustained single-IP burn degrades to the mailto fallback, not a full denial (accepted residual).
	if (env.FEEDBACK_LIMITER) {
		try {
			const { success } = await env.FEEDBACK_LIMITER.limit({ key: getClientAddress() });
			if (!success) return json({ ok: false }, { status: 429 });
		} catch {
			// A limiter failure must not take the endpoint down; fall through (Resend's daily quota is
			// the backstop). Same "guard external I/O" idiom as the fetch below.
		}
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json({ ok: false }, { status: 400 });
	}

	// Rate-limiting is handled above by the binding, so decide's own checkLimit is a pass-through here.
	const decision = await decideFeedback(raw, { checkLimit: async () => true });
	if (decision.kind !== 'send') return json({ ok: false }, { status: 400 });

	let res: Response;
	try {
		res = await fetch(RESEND_ENDPOINT, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.RESEND_API_KEY}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				from: env.FEEDBACK_FROM,
				to: env.FEEDBACK_TO,
				subject: decision.email.subject,
				text: decision.email.text,
				...(decision.email.replyTo ? { reply_to: decision.email.replyTo } : {})
			})
		});
	} catch {
		// Transport failure (DNS/TLS/timeout) - the same "upstream failed" class as a non-ok response.
		return json({ ok: false }, { status: 502 });
	}

	return json({ ok: res.ok }, { status: res.ok ? 200 : 502 });
};
