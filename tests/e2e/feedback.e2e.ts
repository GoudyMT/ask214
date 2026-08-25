import { expect, test } from '@playwright/test';

// Block the service worker so page.route reliably intercepts the /api/feedback POST across engines
// (webkit's SW otherwise handles the fetch before the mock applies, and the submit sees a real 404).
test.use({ serviceWorkers: 'block' });

test('footer Feedback link opens the form and a message can be sent', async ({ page }) => {
	await page.route('**/api/feedback', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
	);
	await page.goto('/about');
	await page.getByRole('contentinfo').getByRole('link', { name: 'Feedback', exact: true }).click();
	await expect(page).toHaveURL(/\/feedback\/?$/);
	// The page the user came from is attached, shown as a friendly name (route only, non-PII).
	await expect(page.getByText(/include the page i was on \(About\)/i)).toBeVisible();
	await page.getByLabel('Your message').fill('the ask page looked off');
	await page.getByRole('button', { name: 'Send feedback' }).click();
	await expect(page.getByText(/your feedback was sent/i)).toBeVisible();
});

test('a failed send shows the mailto fallback', async ({ page }) => {
	await page.route('**/api/feedback', (route) =>
		route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' })
	);
	await page.goto('/feedback');
	await page.getByLabel('Your message').fill('hi');
	await page.getByRole('button', { name: 'Send feedback' }).click();
	await expect(page.getByRole('link', { name: /feedback@ask214\.com/ })).toBeVisible();
});
