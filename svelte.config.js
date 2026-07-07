import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		csp: {
			// Hash mode generates SHA hashes for SvelteKit's inline hydration scripts and
			// injects them into script-src - avoids 'unsafe-inline' on scripts. Style-src
			// keeps 'unsafe-inline' for Svelte's per-component <style> blocks (deferred to
			// v1.1 cleanup via the same hash mechanism).
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				// 'wasm-unsafe-eval' lets the embedding worker compile the self-hosted ONNX WASM;
				// it does NOT permit JS eval(). connect-src stays 'self' - no third-party fetch.
				'script-src': ['self', 'wasm-unsafe-eval'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:'],
				'font-src': ['self', 'data:'],
				// connect-src restricted to 'self' for Phase 1. Google hosts will be added
				// when Google Calendar OAuth lands, with an ADR documenting the exact host
				// list (accounts.google.com, oauth2.googleapis.com, www.googleapis.com).
				// Pre-allowing them now would widen attack surface for zero current benefit.
				'connect-src': ['self'],
				'frame-ancestors': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'manifest-src': ['self'],
				'worker-src': ['self'],
				// Blocks Flash/legacy plugin injection vectors per OWASP ASVS V14.4.3.
				'object-src': ['none'],
				// Coerces any same-origin http:// reference to https:// before the request
				// fires (OWASP ASVS V14.4.5). SvelteKit accepts boolean for valueless
				// directives like this one.
				'upgrade-insecure-requests': true
			}
		}
	}
};

export default config;
