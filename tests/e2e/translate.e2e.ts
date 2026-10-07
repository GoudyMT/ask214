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

// The Ask view repeats a typed question back while it waits for the user's choice. The question has not been sent
// anywhere yet, so a page translation must not carry it off either: first at the online consent question, then at the
// on-device setup offer that "Stay on device" leads to.
test('a question held for a choice stays out of page translation', async ({ page }) => {
	await page.goto('/');
	const input = page.getByRole('textbox', { name: /ask a question/i });
	await expect(input).toBeEnabled();
	await input.fill('What is SkillBridge?');
	await page.getByRole('button', { name: /^search$/i }).click();
	await expect(
		page.getByRole('heading', { name: /send your question to answer online/i })
	).toBeVisible();
	const atConsent = page.getByText('"What is SkillBridge?"');
	await expect(atConsent.locator('xpath=ancestor-or-self::*[@translate="no"]')).toHaveCount(1);

	await page.getByRole('button', { name: /^stay on device$/i }).click();
	await expect(page.getByRole('heading', { name: /one-time setup/i })).toBeVisible();
	const atSetup = page.getByText('"What is SkillBridge?"');
	await expect(atSetup.locator('xpath=ancestor-or-self::*[@translate="no"]')).toHaveCount(1);
});
