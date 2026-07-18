import { expect, test } from '@playwright/test';

// The Ask is the home page now (ADR-022/024). /ask stays as a permanent redirect so old links land.
test('/ask redirects to the home page', async ({ page }) => {
	await page.goto('/ask');
	await expect(page).toHaveURL(/\/$/); // redirected to the root, not left on /ask
	// the home page IS the Ask - its defining control, the query input, is present
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeVisible();
});
