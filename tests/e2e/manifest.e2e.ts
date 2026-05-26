import { expect, test } from '@playwright/test';

test('PWA manifest is reachable and well-formed', async ({ request }) => {
	const resp = await request.get('/manifest.webmanifest');
	expect(resp.status()).toBe(200);
	expect(resp.headers()['content-type']).toMatch(/manifest|json/);
	const manifest = await resp.json();
	expect(manifest.name).toBeTruthy();
	expect(manifest.short_name).toBeTruthy();
	expect(manifest.start_url).toBeTruthy();
	expect(manifest.display).toBe('standalone');
	expect(Array.isArray(manifest.icons)).toBe(true);
	expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
});

test('manifest <link> is present in the HTML head', async ({ page }) => {
	await page.goto('/');
	const href = await page.locator('link[rel="manifest"]').getAttribute('href');
	expect(href).toMatch(/manifest\.webmanifest$/);
});
