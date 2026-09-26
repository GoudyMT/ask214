import { expect, test } from '@playwright/test';
import { DEVICE_FILES } from '../../src/lib/ask/device-files';

// Acceptance: the offline "Ask" must answer with NO network after a one-time warm load - the whole
// privacy + offline premise (Context 1). Real model, no stub: a stubbed embed would not test
// offline inference, which is the thing under test. Heavy (~45MB model + ORT wasm + in-browser ONNX, plus
// an offline reload that must re-initialize from the service-worker cache), so it is tagged @slow and kept
// out of the fast/default + CI runs (run on demand via `pnpm test:e2e:offline`). Queries are taken from
// the eval set (src/lib/ask/eval/queries.json) so a result card is guaranteed (recall@5 = 1.0 at q8).

test('ask answers fully offline after a warm load @slow', async ({
	page,
	context,
	browserName
}) => {
	// Chromium only. Under Playwright's WebKit, `context.setOffline(true)` fails every request from a page the
	// worker controls before the worker can answer it - a precached /_app/immutable/ file included - so the
	// offline reload below fails there whatever the app does. Real iOS Safari is covered by the release gate's
	// device smoke.
	test.skip(
		browserName === 'webkit',
		'Playwright WebKit offline fails a worker-controlled request before the worker can answer it'
	);
	test.setTimeout(180_000);

	// A first visit, used as a person would: no waiting for the service worker and no online reload before
	// going offline. The install keeps the app page, and the setup's downloads wait for the worker.
	await page.goto('/');

	const input = page.getByLabel('Ask a question');
	await expect(input).toBeEnabled({ timeout: 30_000 }); // usable at once; the corpus loads lazily on the query

	// Online is the on-ramp default; this test exercises the on-device offline path, so select it first.
	await page.getByRole('button', { name: /^on device$/i }).click();

	// --- Warm: opt in so the real model downloads through the SW and is cached (model + wasm + corpus) ---
	await input.fill('what is SkillBridge and how long does it last?');
	await page.getByRole('button', { name: 'Search' }).click();

	// First-ever query -> soft opt-in consent -> the one-time download.
	await page.getByRole('button', { name: /set up.+answer/i }).click();
	await expect(page.locator('.ask-card--lead')).toBeVisible({ timeout: 150_000 });

	// --- Go offline and RELOAD: the app must re-initialize entirely from the SW cache ---
	await context.setOffline(true);
	await page.reload();
	await expect(input).toBeEnabled({ timeout: 30_000 }); // usable at once, offline; corpus from SW cache on the query
	// The reload recreates the store at the online default; select device again for the offline query.
	await page.getByRole('button', { name: /^on device$/i }).click();

	// Confirm the SW (not Playwright's / the browser's HTTP cache) served this offline reload - a genuine
	// service-worker-cache offline proof, not an incidental cache hit.
	expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

	// A brand-new query, fully offline: the model re-loads from cache into the worker; embed + search run locally.
	// The files are in the cache, so there is no second consent prompt.
	await input.fill('how can I enroll in VA health care?');
	await page.getByRole('button', { name: 'Search' }).click();
	await expect(page.locator('.ask-card--lead')).toBeVisible({ timeout: 90_000 });

	// The offline reader opens with no network too (pure client render over the held corpus text).
	await page.locator('.ask-card--lead .ask-card__read').click();
	await expect(page.locator('dialog.reader .reader__title')).toBeVisible();
});

// A first visitor who asks at once taps Set up while the worker is still installing. Everything that download
// fetches must still be kept, or the "one-time" download happens again and nothing works offline.
test('a setup tapped before the worker takes charge still keeps every file @slow', async ({
	page,
	browserName
}) => {
	test.skip(
		browserName === 'webkit',
		'Playwright WebKit offline fails a worker-controlled request before the worker can answer it'
	);
	test.setTimeout(180_000);

	// Hold back the page's call that registers the worker, so the page is not controlled when Set up is tapped.
	// Page-side, so the test does not depend on routing the worker's own requests.
	await page.addInitScript(() => {
		const container = navigator.serviceWorker;
		const register = container.register.bind(container);
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		(window as unknown as { releaseWorker: () => void }).releaseWorker = release;
		container.register = (...args: Parameters<ServiceWorkerContainer['register']>) =>
			held.then(() => register(...args));
	});
	await page.goto('/');
	const input = page.getByLabel('Ask a question');
	await expect(input).toBeEnabled({ timeout: 30_000 });
	await page.getByRole('button', { name: /^on device$/i }).click();
	await input.fill('what is SkillBridge and how long does it last?');
	await page.getByRole('button', { name: 'Search' }).click();
	await page.getByRole('button', { name: /set up.+answer/i }).click();
	// The premise: no worker is in charge as the download is asked for.
	expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
	await page.evaluate(() => (window as unknown as { releaseWorker: () => void }).releaseWorker());
	await expect(page.locator('.ask-card--lead')).toBeVisible({ timeout: 150_000 });

	// Exactly the files an on-device answer needs are kept - no fewer, and none this list does not name.
	await expect
		.poll(
			() =>
				page.evaluate(async () =>
					(await (await caches.open('ask-assets-v1')).keys())
						.map((request) => new URL(request.url).pathname)
						.filter((path) => /^\/(models|wasm|corpus)\//.test(path))
						.sort()
				),
			{ timeout: 30_000 }
		)
		.toEqual([...DEVICE_FILES].sort());
});
