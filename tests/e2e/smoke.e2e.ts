import { expect, test } from '@playwright/test';

test('home page renders with header + main + footer landmarks', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('banner')).toBeVisible();
	await expect(page.getByRole('main')).toBeVisible();
	await expect(page.getByRole('contentinfo')).toBeVisible();
	await expect(page.locator('h1')).toContainText(/transition/i);
});

test('skip-to-content link is the first focusable element on the page', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('banner')).toBeVisible();
	// Assert the invariant directly - the skip link is the first focusable element in DOM order - rather
	// than pressing Tab: WebKit excludes links from its default Tab order, so a Tab probe tests Safari's
	// keyboard behavior, not our page. The skip link stays reachable there via VoiceOver / full keyboard.
	const firstFocusable = await page.evaluate(() => {
		const el = document.querySelector(
			'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])'
		);
		return (el?.textContent ?? '').trim().toLowerCase();
	});
	expect(firstFocusable).toContain('skip');
});

test('About link navigates to /about', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: /about/i }).first().click();
	await expect(page).toHaveURL(/\/about\/?$/);
	await expect(page.locator('h1')).toContainText(/about/i);
});

// Lock #4: header is `position: sticky` (pure CSS, no JS). Tested via computed style
// rather than scroll behavior to avoid flaky scroll-position dependencies in headless mode.
test('header has sticky positioning', async ({ page }) => {
	await page.goto('/');
	const position = await page.locator('header').evaluate((el) => getComputedStyle(el).position);
	expect(position).toBe('sticky');
});
