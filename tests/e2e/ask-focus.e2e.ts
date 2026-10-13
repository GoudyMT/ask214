import { expect, test } from '@playwright/test';

// A keyboard or screen-reader press on a button that goes away with its card must leave the person in the question
// field, not at the top of the page. Both engines: WebKit is the one closest to Safari.
test('a feed question pressed by keyboard leaves focus in the question field', async ({ page }) => {
	await page.goto('/');
	const input = page.getByRole('textbox', { name: 'Ask a question' });
	await expect(input).toBeEnabled();

	await page.locator('.q-feed__pill').first().focus();
	await page.keyboard.press('Enter');

	// Online is the default and nothing is agreed yet, so the question reaches the consent step and the feed is gone.
	await expect(page.locator('.q-feed')).toHaveCount(0);
	await expect(input).toBeFocused();
});

test('Not now pressed by keyboard leaves focus in the question field', async ({ page }) => {
	await page.goto('/');
	const input = page.getByRole('textbox', { name: 'Ask a question' });
	await expect(input).toBeEnabled();
	await page.getByRole('button', { name: 'On device', exact: true }).click();
	await input.fill('How do I apply for SkillBridge?');
	await page.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(page.getByText(/one-time setup to answer your question/i)).toBeVisible();

	await page.getByRole('button', { name: 'Not now' }).focus();
	await page.keyboard.press('Enter');

	await expect(page.getByText(/one-time setup to answer your question/i)).toHaveCount(0);
	await expect(input).toBeFocused();
});
