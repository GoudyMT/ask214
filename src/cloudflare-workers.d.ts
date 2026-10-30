// The deployment's bindings, as the app's server routes read them from the workerd-only `cloudflare:workers`
// module. Only what the app uses is declared, so a binding read here and missing from wrangler.toml stays a choice.
declare module 'cloudflare:workers' {
	export const env: {
		// Resend API key - a secret (wrangler secret / .dev.vars); never committed.
		RESEND_API_KEY?: string;
		// Feedback email destination + sender - deployment vars (.dev.vars / wrangler); not committed.
		FEEDBACK_TO?: string;
		FEEDBACK_FROM?: string;
		// Cloudflare per-IP rate-limit binding (wrangler.toml [[ratelimits]]).
		FEEDBACK_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
	};
}
