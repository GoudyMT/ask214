import { expect, test } from '@playwright/test';

// The Ask is the home page now (ADR-022/024). /ask stays as a permanent redirect so old links land.
test('/ask redirects to the home page', async ({ page }) => {
	await page.goto('/ask');
	await expect(page).toHaveURL(/\/$/); // redirected to the root, not left on /ask
	// the home page IS the Ask - its defining control, the query input, is present
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeVisible();
});

test('the home page leads with the hero headline and the Ask input', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toContainText(/military transition/i);
	// the input is the hero action; it enables once the corpus (a small static asset) loads
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
});

test('the model is NOT downloaded on page load (soft opt-in)', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
	// `mtc:ask:model-downloaded` is the shipped NON-PII device-capability flag (store.svelte.ts): it
	// records only "was the model fetched on this device" - no query, no profile, nothing personal.
	// ADR-004's encrypted-IDB rule governs PII, which this is not; reading it asserts the soft opt-in held.
	const flag = await page.evaluate(() => localStorage.getItem('mtc:ask:model-downloaded'));
	expect(flag).toBeNull();
});

test('asking on a fresh profile replaces the on-ramp with the setup prompt in place', async ({
	page
}) => {
	await page.goto('/');
	const input = page.getByRole('textbox', { name: /ask a question/i });
	await expect(input).toBeEnabled();
	// idle + no profile: the on-ramp is visible
	await expect(page.getByRole('heading', { name: /make it yours/i })).toBeVisible();
	// ask -> the soft opt-in prompt takes the space; the on-ramp is gone (results own the page)
	await input.fill('How do I apply for SkillBridge?');
	await page.getByRole('button', { name: /^search$/i }).click();
	await expect(page.getByText(/one-time setup to answer your question/i)).toBeVisible();
	await expect(page.getByRole('heading', { name: /make it yours/i })).toHaveCount(0);
});

test('a fresh profile hides the Settings tab, and /settings redirects to the front door', async ({
	page
}) => {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
	// No separation date yet -> nothing in Settings applies, so the tab is hidden...
	await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
	// ...and a deep link to it bounces to the front door, where the setup on-ramp lives.
	await page.goto('/settings');
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeVisible();
});

test('the Ask input is the first focusable control in the page content', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
	// Spec section 12: the input is the first tab stop. Asserted structurally (WebKit omits links from the
	// default Tab order, so a keypress probe is engine-dependent): the first focusable element inside
	// <main> is the Ask input, so nothing steals focus ahead of the hero action.
	const inputIsFirst = await page.evaluate(() => {
		const main = document.querySelector('main');
		const first = main?.querySelector(
			'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])'
		);
		return first instanceof HTMLElement && first.matches('input.ask-input');
	});
	expect(inputIsFirst).toBe(true);
});
