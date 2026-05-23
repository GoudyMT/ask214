import { expect, test } from '@playwright/test';

test('service worker registers and activates on home page', async ({ page }) => {
	await page.goto('/');

	// `navigator.serviceWorker.ready` resolves while the active worker may still be
	// in 'activating' state (the activate handler's waitUntil is still running cache
	// cleanup + clients.claim). Wait for the state to reach 'activated' explicitly.
	const state = await page.evaluate(async () => {
		if (!('serviceWorker' in navigator)) return 'unsupported';
		const reg = await navigator.serviceWorker.ready;
		if (!reg.active) return 'no-active-worker';

		return new Promise<string>((resolve) => {
			const check = () => {
				if (reg.active?.state === 'activated') resolve('activated');
			};
			reg.active!.addEventListener('statechange', check);
			// Race check: state may have changed between .ready and listener registration.
			check();
		});
	});

	expect(state).toBe('activated');
});

test('built assets are served from the service worker cache after first visit', async ({
	page
}) => {
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);

	const cacheNames = await page.evaluate(async () => (await caches.keys()) ?? []);
	expect(cacheNames.length).toBeGreaterThan(0);
	expect(cacheNames.some((name) => name.startsWith('app-'))).toBe(true);
});
