import { readFileSync } from 'node:fs';
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

// The suite's config asks for reduced motion so the home feed holds still under a tap. A misplaced
// option fails silently (the page simply animates), so read the preference from the page itself.
test('the test browser asks for reduced motion', async ({ page }) => {
	await page.goto('/');
	const reduced = await page.evaluate(
		() => window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
	expect(reduced).toBe(true);
});

test('About link navigates to /about', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: /about/i }).first().click();
	await expect(page).toHaveURL(/\/about\/?$/);
	await expect(page.locator('h1')).toContainText(/about/i);
});

// The footer names the release the page was built from, read from package.json at build time, and links to its notes.
test('the footer shows the version from package.json, linked to its release notes', async ({
	page
}) => {
	const { version } = JSON.parse(readFileSync('package.json', 'utf-8')) as { version: string };
	await page.goto('/');
	const link = page
		.getByRole('contentinfo')
		.getByRole('link', { name: `v${version}`, exact: true });
	await expect(link).toHaveAttribute(
		'href',
		`https://github.com/GoudyMT/ask214/releases/tag/v${version}`
	);
	await expect(link).toHaveAttribute('rel', 'external');
});

// The header is `position: sticky` (pure CSS, no JS). Tested via computed style
// rather than scroll behavior to avoid flaky scroll-position dependencies in headless mode.
test('header has sticky positioning', async ({ page }) => {
	await page.goto('/');
	const position = await page.locator('header').evaluate((el) => getComputedStyle(el).position);
	expect(position).toBe('sticky');
});
