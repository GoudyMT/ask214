import { expect, test } from '@playwright/test';

// 100 days out (task-defs.ts as of this PR): the BDD claim, the TAP Capstone and both separation-exam tasks have
// their last day 90 days before separation - ten days away, so closing soon - and preseparation counseling (due
// 365 days before) is late.
const DAY = 86_400_000;
const isoFromToday = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

test('"Needs you now" lists a closing BDD window and jumps to its card', async ({ page }) => {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(isoFromToday(100));
	await page.getByRole('button', { name: /save and continue/i }).click();
	const panel = page.getByRole('region', { name: /needs you now/i });
	await expect(panel).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Late' })).toBeVisible();
	await expect(panel.getByRole('heading', { name: 'Closing soon' })).toBeVisible();
	const row = panel.getByRole('link', { name: /File your VA disability claim through BDD/ });
	await expect(row).toContainText('10 days');
	await row.click();
	await expect(page.locator('#task-va-bdd-claim')).toBeInViewport();
	// A soft task past its window is calm, not red: nothing on the page reads "Overdue" any more.
	await expect(page.getByText('Overdue', { exact: true })).toHaveCount(0);
});
