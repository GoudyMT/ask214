import { expect, test } from '@playwright/test';

// Pages open offline from the page the worker keeps at install: after a first visit, whose own page load came
// before the worker could keep it, and after an update, whose install keeps a fresh copy while the release before
// it is deleted. A page never opened while the worker was in charge takes the same path as every page does after
// an update.
//
// Chromium only. Under Playwright's WebKit, `context.setOffline(true)` fails every request from a page the worker
// controls before the worker can answer it, so no offline page can load there whatever the app does. Real iOS
// Safari is covered by the release gate's device smoke.
test.skip(
	({ browserName }) => browserName === 'webkit',
	'Playwright WebKit offline fails a worker-controlled request before the worker can answer it'
);

test('a page never opened while the worker was in charge opens offline, with its security policy', async ({
	page,
	context
}) => {
	await page.goto('/');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise<void>((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
					once: true
				})
			);
	});
	// The first load came before the worker, so install is the only way the site root is in the page cache.
	const kept = await page.evaluate(async () => {
		for (const name of await caches.keys()) {
			if (!name.startsWith('app-')) continue;
			if (await (await caches.open(name)).match('/')) return true;
		}
		return false;
	});
	expect(kept).toBe(true);

	await context.setOffline(true);
	const pages: [string, string | RegExp][] = [
		['/documents', 'Documents'],
		['/about', 'About'],
		['/', /military transition/i]
	];
	for (const [path, heading] of pages) {
		const response = await page.goto(path);
		expect(response?.fromServiceWorker()).toBe(true);
		expect(response?.headers()['content-security-policy'] ?? '').toContain("default-src 'self'");
		await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
	}
});
