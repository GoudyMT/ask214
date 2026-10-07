import { expect, test } from '@playwright/test';

// A browser's page translation (Safari's always; Chrome's on a phone set to another language) sends the page's text
// to a translation service. The screens that show the separation date, the leaving dates or task dates worked out from
// them mark their content translate="no"; the public screens stay translatable for readers who need them.
const PERSONAL: ReadonlyArray<[path: string, heading: string]> = [
	['/timeline', 'Timeline'],
	['/settings', 'Settings'],
	['/wizard', 'Set up your profile']
];
const PUBLIC = ['/', '/documents', '/about'];

for (const [path, heading] of PERSONAL) {
	test(`${path} keeps its content out of page translation`, async ({ page }) => {
		await page.goto(path);
		const h1 = page.getByRole('heading', { level: 1, name: heading });
		await expect(h1).toBeVisible();
		await expect(h1.locator('xpath=ancestor::*[@translate="no"]')).toHaveCount(1);
	});
}

for (const path of PUBLIC) {
	test(`${path} stays translatable`, async ({ page }) => {
		await page.goto(path);
		await expect(page.locator('main#main-content')).toBeVisible();
		await expect(page.locator('[translate="no"]')).toHaveCount(0);
	});
}
