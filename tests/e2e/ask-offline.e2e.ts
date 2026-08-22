import { expect, test } from '@playwright/test';

// Acceptance: the offline "Ask" must answer with NO network after a one-time warm load - the whole
// privacy + offline premise (Context 1). Real model, no stub: a stubbed embed would not test
// offline inference, which is the thing under test. Heavy (~45MB model + ORT wasm + in-browser ONNX, plus
// an offline reload that must re-initialize from the service-worker cache), so it is tagged @slow and kept
// out of the fast/default + CI runs (run on demand via `pnpm test:e2e:offline`). Queries are taken from
// the eval set (src/lib/ask/eval/queries.json) so a result card is guaranteed (recall@5 = 1.0 at q8).

test('ask answers fully offline after a warm load @slow', async ({ page, context }) => {
	test.setTimeout(180_000);

	// First visit installs the service worker. Wait until it CONTROLS this client, then reload once
	// online so the now-controlling SW caches the /ask navigation - the first load happened before the
	// SW took control, so the page itself was not in the cache yet (navigations are cached network-first).
	await page.goto('/ask');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller) {
			await new Promise<void>((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
					once: true
				})
			);
		}
	});
	await page.reload();

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

	// A brand-new query, fully offline: the model re-loads from cache into the worker; embed + search
	// run locally. The persisted "downloaded" flag means no second consent prompt.
	await input.fill('how can I enroll in VA health care?');
	await page.getByRole('button', { name: 'Search' }).click();
	await expect(page.locator('.ask-card--lead')).toBeVisible({ timeout: 90_000 });

	// The offline reader opens with no network too (pure client render over the held corpus text).
	await page.locator('.ask-card--lead .ask-card__read').click();
	await expect(page.locator('dialog.reader .reader__title')).toBeVisible();
});
