import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { decideFeedback } from '$lib/feedback/decide';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export const POST: RequestHandler = async ({ request, platform, getClientAddress }) => {
	const env = platform?.env;
	// The API key + destination are deployment config (a secret + a var), never committed to the repo.
	if (!env?.RESEND_API_KEY || !env.FEEDBACK_TO) return json({ ok: false }, { status: 500 });
	// A verified Resend sender; falls back to Resend's shared test sender for a first smoke.
	const from = env.FEEDBACK_FROM ?? 'Ask 214 <onboarding@resend.dev>';

	// Per-IP rapid-fire limit (atomic edge binding). Resend's free-tier daily quota is the hard
	// inbox-flood backstop, so no separate daily counter is needed.
	if (env.FEEDBACK_LIMITER) {
		const { success } = await env.FEEDBACK_LIMITER.limit({ key: getClientAddress() });
		if (!success) return json({ ok: false }, { status: 429 });
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

	const res = await fetch(RESEND_ENDPOINT, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${env.RESEND_API_KEY}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			from,
			to: env.FEEDBACK_TO,
			subject: decision.email.subject,
			text: decision.email.text,
			...(decision.email.replyTo ? { reply_to: decision.email.replyTo } : {})
		})
	});

	return json({ ok: res.ok }, { status: res.ok ? 200 : 502 });
};
