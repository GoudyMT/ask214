import { expect, test } from '@playwright/test';

// 100 days out (as in needs-now.e2e.ts): some tasks are late and some close within 30 days, so the row has a count.
// The app's today is the date on the device clock, so the seed counts local calendar days too.
const isoFromToday = (days: number) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function seedProfile(page: import('@playwright/test').Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(isoFromToday(100));
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

test('Home names the timeline count the Timeline shows, and its row opens the Timeline', async ({
	page
}) => {
	await seedProfile(page);
	const summary = page.getByRole('region', { name: /needs you now/i });
	const count = (await summary.locator('.needs-now__count').textContent())?.trim();
	expect(Number(count)).toBeGreaterThan(1);

	await page.goto('/');
	const region = page.getByRole('region', { name: 'For you' });
	const row = region.getByRole('link', {
		name: new RegExp(`Your timeline - ${count} need you now`)
	});
	await expect(row).toBeVisible();
	await expect(row).toContainText('Late');
	// Ask stays first on the page: the row comes after the question field.
	const field = page.locator('.ask-input');
	const fieldBox = await field.boundingBox();
	const rowBox = await row.boundingBox();
	expect(rowBox!.y).toBeGreaterThan(fieldBox!.y);

	await row.click();
	await expect.poll(() => new URL(page.url()).pathname).toBe('/timeline');
	await expect(page.getByRole('region', { name: /needs you now/i })).toBeVisible();
});

test('a locked profile shows a locked row with no task or date', async ({ page }) => {
	await seedProfile(page);
	await page.goto('/settings');
	await page.getByRole('button', { name: /^lock$/i }).click();
	await expect(page.getByRole('button', { name: /^unlock$/i })).toBeVisible();

	// Within the app, so the lock holds: a full reload would open the profile again.
	await page.getByRole('link', { name: 'Ask 214' }).click();
	const row = page.getByRole('region', { name: 'For you' }).getByRole('link');
	await expect(row).toContainText('Your timeline - locked');
	await expect(row).toContainText('Unlock to see what is due');
	await expect(row).not.toContainText(/20[0-9][0-9]/);
});
