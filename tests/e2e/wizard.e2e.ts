import { expect, test } from '@playwright/test';

// Regression coverage for the shipped wizard flow. The Home setup CTA
// appears only when there is no EAOS yet; saving an EAOS removes it; skipping leaves it in place
// (soft gate). Each test runs in a fresh browser context, so IndexedDB starts empty.

test('wizard happy path: Get started -> save EAOS -> Home drops the setup CTA', async ({
	page
}) => {
	await page.goto('/');
	const cta = page.getByRole('link', { name: /get started/i });
	await expect(cta).toBeVisible();

	await cta.click();
	await expect(page.getByLabel(/separation date/i)).toBeVisible();

	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();

	// Back on Home, with an EAOS now stored, so the CTA is gone.
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeVisible();
	await expect(page.getByRole('link', { name: /set up your timeline/i })).toBeHidden();
});

test('wizard skip is a soft gate: Home keeps the CTA and it re-engages', async ({ page }) => {
	await page.goto('/wizard');
	await expect(page.getByLabel(/separation date/i)).toBeVisible();

	await page.getByRole('button', { name: /skip for now/i }).click();

	// Skipped without saving, so the CTA persists (soft gate).
	const cta = page.getByRole('link', { name: /get started/i });
	await expect(cta).toBeVisible();

	await cta.click();
	await expect(page.getByLabel(/separation date/i)).toBeVisible();
});
