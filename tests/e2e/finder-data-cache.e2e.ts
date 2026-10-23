import { expect, test } from '@playwright/test';

// A SkillBridge listing file is public, but which files a device fetched narrows where the person is looking, so the
// worker passes these requests to the network and keeps no copy: a copy would sit in plain text in Cache Storage and
// survive an Erase (which keeps dotted names in app-* caches). The page is controlled by the worker for the fetch, so
// the check is a real pass through it.
//
// Chromium only. Why: on Playwright WebKit the worker controls the page, but a route does not answer a fetch the page
// makes under a worker, so the page gets the preview server's 404 page and the test has no body to control against.
// Where WebKit's coverage comes from: the bypass is the same worker script on every engine, so the isFinderDataRequest
// unit tests (src/lib/ask/asset-cache.test.ts) and this Chromium run cover it.
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
	await context.route('**/finder-cache-probe.json', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
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

	// The worker writes a copy after it serves a response, so a missing entry could just be a write not yet made. A
	// second file the worker does keep is fetched after the data file; once its copy shows in the cache, the write
	// path has run for this test, and a data-file copy that was going to be written would be there too.
	await page.evaluate(async () => (await fetch('/finder-cache-probe.json')).text());
	const heldUrls = () =>
		page.evaluate(async () => {
			const urls: string[] = [];
			for (const name of await caches.keys())
				for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
			return urls;
		});
	await expect.poll(heldUrls).toContainEqual(expect.stringContaining('/finder-cache-probe.json'));
	expect((await heldUrls()).filter((url) => url.includes('/skillbridge-data/'))).toEqual([]);
});
