// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	// The release version from package.json, built in by `define` in vite.config.ts.
	const __APP_VERSION__: string;
	namespace App {
		interface Platform {
			env?: {
				// Resend API key - a secret (wrangler secret / .dev.vars); never committed.
				RESEND_API_KEY?: string;
				// Feedback email destination + sender - deployment vars (.dev.vars / wrangler); not committed.
				FEEDBACK_TO?: string;
				FEEDBACK_FROM?: string;
				// Cloudflare per-IP rate-limit binding (wrangler.toml [[ratelimits]]).
				FEEDBACK_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
			};
		}
	}
}

export {};
