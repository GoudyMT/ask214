import { expect, test } from '@playwright/test';

// A mistyped or outdated address, in a real browser against the built app: the server says 404, the page says so in the
// app's own words, and one link leads home. Phone width is set because the projects are desktop browsers.
test('a missing address answers 404 with a page not found page, and Go to Home leads to Home', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 568 });
	const response = await page.goto('/no-such-page');
	expect(response?.status()).toBe(404);
	await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
	await expect(page.getByText('This page does not exist.')).toBeVisible();
	await expect(page).toHaveTitle('Page not found - Ask 214');
	// No sideways scroll on the narrowest phone.
	const [scrollWidth, clientWidth] = await page.evaluate(() => [
		document.documentElement.scrollWidth,
		document.documentElement.clientWidth
	]);
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

	await page.getByRole('main').getByRole('link', { name: 'Go to Home' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page).not.toHaveTitle(/Page not found/);
});
