import { describe, it, expect } from 'vitest';
import config from '../../../svelte.config.js';

// The CSP is defined in svelte.config.js kit.csp.directives and emitted by SvelteKit at render. This
// asserts the egress contract at its source (pre-commit + cross-platform); the live emission is covered by
// tests/e2e/security.e2e.ts.
const directives = config.kit?.csp?.directives;

describe('CSP egress contract', () => {
	it('connect-src is exactly self plus the one path-scoped Anthropic messages endpoint', () => {
		// Browser-direct BYO-key synthesis POSTs to api.anthropic.com/v1/messages; the retrieve Worker is
		// same-origin ('self'). Path-scoped (no trailing slash) so the browser blocks every other Anthropic
		// path -- /v1/messages/batches, /v1/files -- as defense-in-depth behind the payload allowlist.
		expect(directives?.['connect-src']).toEqual(['self', 'https://api.anthropic.com/v1/messages']);
	});

	it('script-src never gains unsafe-inline, unsafe-eval, or an external host', () => {
		const scriptSrc = directives?.['script-src'] ?? [];
		expect(scriptSrc).not.toContain('unsafe-inline');
		expect(scriptSrc).not.toContain('unsafe-eval');
		for (const src of scriptSrc) {
			expect(src, `script-src must carry no external host, found ${src}`).not.toMatch(
				/^https?:\/\//
			);
		}
	});

	it('script-src pins the pre-paint theme script hash so it cannot be dropped', () => {
		const scriptSrc = directives?.['script-src'] ?? [];
		expect(scriptSrc.some((s) => s.startsWith('sha256-'))).toBe(true);
	});
});
