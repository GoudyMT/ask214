import { expect, test } from '@playwright/test';

// A SkillBridge listing file is public, but which files a device fetched narrows where the person is looking, so the
// worker passes these requests to the network and keeps no copy: a copy would sit in plain text in Cache Storage and
// survive an Erase (which keeps dotted names in app-* caches). The page is controlled by the worker for the fetch, so
// the check is a real pass through it.
//
// Chromium only: on Playwright WebKit the worker controls the page, but a route does not answer a fetch the page makes
// under a worker, so the page gets the preview server's 404 page and the test has no body to control against.
test('a SkillBridge data file fetched through the service worker is stored in no cache', async ({
	page,
	context,
	browserName
}) => {
	test.skip(
		browserName === 'webkit',
		'a route does not answer a fetch made under a service worker on Playwright WebKit'
	);
	const BODY = JSON.stringify({ probe: 'finder-data-cache' });
	await context.route('**/skillbridge-data/index.json', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: BODY })
	);

	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	// A first visit is not controlled until the worker claims it; reload so the fetch below goes through the worker.
	await page.reload();
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

	// Control: the body is the routed one, so the request really went through the worker and the route.
	const got = await page.evaluate(async () => {
		const response = await fetch('/skillbridge-data/index.json', { cache: 'no-store' });
		return response.text();
	});
	expect(got).toBe(BODY);

	// The worker writes a copy after the response is served, so wait for the cache writes of this request to settle.
	await page.waitForTimeout(1_000);
	const held = await page.evaluate(async () => {
		const urls: string[] = [];
		for (const name of await caches.keys())
			for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
		return urls;
	});
	// Guard against a vacuous pass: the app's own caches are there and hold something.
	expect(held.length).toBeGreaterThan(0);
	expect(held.filter((url) => url.includes('/skillbridge-data/'))).toEqual([]);
});
