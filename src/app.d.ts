// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Platform {
			env?: {
				// Resend API key - a secret (wrangler secret / .dev.vars); never committed.
				RESEND_API_KEY?: string;
				// Cloudflare per-IP rate-limit binding (wrangler.toml [[ratelimits]]).
				FEEDBACK_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
			};
		}
	}
}

export {};
