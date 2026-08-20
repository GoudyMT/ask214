import { expect, test } from '@playwright/test';

// The theme control persists the choice, and the pre-paint script in app.html re-applies it before
// first paint on the next load (the no-flash promise). The Appearance card is not gated behind the
// timeline, so this needs no profile setup.
test('theme choice applies, swaps the palette, and survives a reload', async ({ page }) => {
	await page.goto('/settings');
	const theme = page.getByRole('group', { name: 'Theme' });
	await expect(theme).toBeVisible();

	// Dark: applied immediately + a concrete dark background.
	await theme.getByRole('button', { name: 'Dark', exact: true }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	expect(darkBg).toBe('rgb(15, 20, 25)'); // --color-bg dark (#0f1419)

	// The choice survives a reload - proving the pre-paint script re-applies it before paint.
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

	// Light: a real, different applied background (the swap is not just the attribute).
	await theme.getByRole('button', { name: 'Light', exact: true }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	expect(lightBg).toBe('rgb(245, 247, 250)'); // --color-bg light (#f5f7fa)
	expect(lightBg).not.toBe(darkBg);

	// System removes the attribute (OS-driven via CSS), and that persists across a reload too.
	await theme.getByRole('button', { name: 'System', exact: true }).click();
	await expect(page.locator('html')).not.toHaveAttribute('data-theme');
	await page.reload();
	await expect(page.locator('html')).not.toHaveAttribute('data-theme');
});

test('the mobile address-bar tint (theme-color) follows the theme', async ({ page }) => {
	await page.goto('/settings');
	const theme = page.getByRole('group', { name: 'Theme' });
	await expect(theme).toBeVisible();

	const themeColors = () =>
		page
			.locator('meta[name="theme-color"]')
			.evaluateAll((ms) => ms.map((m) => (m as HTMLMetaElement).content));

	// Explicit Dark: both metas point at the dark bg, so the bar is dark regardless of the OS.
	await theme.getByRole('button', { name: 'Dark', exact: true }).click();
	expect(await themeColors()).toEqual(['#0f1419', '#0f1419']);

	// Explicit Light: both point at the light bg.
	await theme.getByRole('button', { name: 'Light', exact: true }).click();
	expect(await themeColors()).toEqual(['#f5f7fa', '#f5f7fa']);

	// System: the OS-driven pair is restored (dark default + a prefers-color-scheme:light override).
	await theme.getByRole('button', { name: 'System', exact: true }).click();
	expect(await themeColors()).toEqual(['#0f1419', '#f5f7fa']);
});
