import { expect, test, type Page } from '@playwright/test';

// The nudge's Install and Dismiss remove the nudge, so the button that was pressed goes with it. Focus must land
// on the question field, not fall to the page, for a person who pressed it by keyboard.

// A browser fires beforeinstallprompt on its own once an app is installable; a test has to send the event, with the
// two members the install controller reads.
async function showNudge(page: Page, outcome: 'accepted' | 'dismissed'): Promise<void> {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
	await page.evaluate((choice) => {
		const event = new Event('beforeinstallprompt', { cancelable: true });
		Object.assign(event, {
			prompt: () => Promise.resolve(),
			userChoice: Promise.resolve({ outcome: choice, platform: '' })
		});
		window.dispatchEvent(event);
	}, outcome);
	await expect(page.locator('.install-nudge')).toBeVisible();
}

test('Dismiss on the install nudge, pressed by keyboard, hands focus to the question field', async ({
	page
}) => {
	await showNudge(page, 'dismissed');
	await page.locator('.install-nudge').getByRole('button', { name: 'Dismiss' }).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('.install-nudge')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeFocused();
});

test('Install on the install nudge, pressed by keyboard, hands focus to the question field', async ({
	page
}) => {
	await showNudge(page, 'accepted');
	await page.locator('.install-nudge').getByRole('button', { name: 'Install' }).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('.install-nudge')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeFocused();
});
