import { expect, test } from '@playwright/test';

// A keyboard or screen-reader user who locks and unlocks keeps their place: Lock hands focus to the Unlock button that
// replaces it, and a good Unlock hands it to the page heading, instead of dropping it to the top of the page.

async function seedProfile(page: import('@playwright/test').Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

test('Lock hands focus to Unlock, and Unlock hands it to the heading', async ({ page }) => {
	await seedProfile(page);
	await page.goto('/settings');

	const lock = page.getByRole('button', { name: /^lock$/i });
	await lock.focus();
	await expect(lock).toBeFocused();
	await page.keyboard.press('Enter');

	const unlock = page.getByRole('button', { name: /^unlock$/i });
	await expect(unlock).toBeFocused();
	await page.keyboard.press('Enter');

	await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeFocused();
	await expect(lock).toBeVisible();
});
