import { expect, test } from '@playwright/test';

// The error catcher is installed by SvelteKit's start-up hook, before any page code runs, and nothing else in the
// app cancels a window error. So a synthetic error that comes back cancelled proves the catcher is live.
test('an error that reaches the window is stopped before the browser reports it', async ({
	page
}) => {
	await page.goto('/');
	await expect
		.poll(() =>
			page.evaluate(() => {
				const ev = new ErrorEvent('error', { message: 'x', cancelable: true });
				window.dispatchEvent(ev);
				return ev.defaultPrevented;
			})
		)
		.toBe(true);
});
