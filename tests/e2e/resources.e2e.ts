import { expect, test } from '@playwright/test';

test('Resources link navigates to /resources and shows the grouped link list', async ({ page }) => {
	await page.goto('/');
	await page
		.getByRole('link', { name: /resources/i })
		.first()
		.click();
	await expect(page).toHaveURL(/\/resources\/?$/);
	await expect(page.locator('h1')).toContainText(/resources/i);

	// Grouped category headings.
	await expect(page.getByRole('heading', { name: 'Benefits & VA' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Claims filing (VSO)' })).toBeVisible();

	// A resource opens the official site safely in a new tab.
	const vaLink = page.locator('a[href="https://www.va.gov"]');
	await expect(vaLink).toHaveAttribute('target', '_blank');
	await expect(vaLink).toHaveAttribute('rel', /noopener/);
});

test('the Claims filing section leads with the 38 CFR boundary note', async ({ page }) => {
	await page.goto('/resources');
	await expect(page.getByText(/does(n't| not) help with VA claims/i)).toBeVisible();
});
