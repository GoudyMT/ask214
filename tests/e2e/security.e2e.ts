import { expect, test } from '@playwright/test';

test('CSP is present and strict (header or meta tag)', async ({ page, request }) => {
	// SvelteKit auto-CSP emits via Content-Security-Policy HTTP header for dynamically
	// rendered pages, and via <meta http-equiv="Content-Security-Policy"> for prerendered
	// pages. Check both so the test is robust to rendering mode.
	const resp = await request.get('/');
	const headerCSP = resp.headers()['content-security-policy'] ?? null;

	let csp: string | null = headerCSP;

	if (!csp) {
		await page.goto('/');
		csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
	}

	expect(csp).toBeTruthy();

	// Verify every directive we configured in svelte.config.js kit.csp.directives is
	// actually emitted. If SvelteKit drops one silently (e.g., upstream regression),
	// the corresponding assertion fails and we know exactly what's missing.
	expect(csp).toMatch(/default-src 'self'/);
	expect(csp).toMatch(/style-src 'self' 'unsafe-inline'/);
	expect(csp).toMatch(/img-src 'self' data:/);
	expect(csp).toMatch(/font-src 'self' data:/);
	expect(csp).toMatch(/connect-src 'self'/);
	expect(csp).toMatch(/frame-ancestors 'none'/);
	expect(csp).toMatch(/base-uri 'self'/);
	expect(csp).toMatch(/form-action 'self'/);
	expect(csp).toMatch(/manifest-src 'self'/);
	expect(csp).toMatch(/worker-src 'self'/);
	expect(csp).toMatch(/object-src 'none'/);
	expect(csp).toMatch(/upgrade-insecure-requests/);

	// script-src must include 'self' and SvelteKit-generated hashes for inline scripts.
	// Most importantly: NO 'unsafe-inline' and NO 'unsafe-eval' on script-src specifically.
	// (The negative assertions are scoped to the script-src directive value, not the full
	// CSP string - style-src has 'unsafe-inline' legitimately and we don't want that to
	// false-positive against script-src.)
	const scriptSrcMatch = csp?.match(/script-src ([^;]+)/);
	expect(scriptSrcMatch).toBeTruthy();
	const scriptSrcValue = scriptSrcMatch![1];
	expect(scriptSrcValue).toMatch(/'self'/);
	expect(scriptSrcValue).not.toMatch(/'unsafe-inline'/);
	expect(scriptSrcValue).not.toMatch(/'unsafe-eval'/);

	// Positive assertion: SvelteKit's mode='hash' must emit at least one SHA hash on
	// script-src. If hash mode silently degrades (upstream regression), the page would
	// still load with script-src 'self' but inline hydration would error at runtime.
	// Without this check, the test would silently pass a broken implementation.
	expect(scriptSrcValue).toMatch(/'sha(256|384|512)-[A-Za-z0-9+/=]+'/);
});

test('all external script sources have SRI integrity attributes', async ({ page }) => {
	// Per _Working Standards.md "Security Standards": SRI on every external asset.
	// If a future component (or vendored snippet) adds a <script src="https://..."> without
	// an integrity attribute, this test catches it before merge.
	await page.goto('/');
	const externalScripts = await page.locator('script[src^="http"]').all();
	for (const s of externalScripts) {
		const src = await s.getAttribute('src');
		const integrity = await s.getAttribute('integrity');
		expect(integrity, `External script ${src} must have an integrity (SRI) attribute`).toBeTruthy();
	}
});

test('security.txt is reachable and well-formed', async ({ request }) => {
	const resp = await request.get('/.well-known/security.txt');
	expect(resp.status()).toBe(200);
	const body = await resp.text();
	expect(body).toMatch(/Contact:/i);
	expect(body).toMatch(/Expires:/i);
	expect(body).toMatch(/Canonical:/i);
});
