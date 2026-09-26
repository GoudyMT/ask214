import { expect, test, type Locator, type Page } from '@playwright/test';

// The source document end to end: what a visit downloads, what the device keeps, and what still opens with
// the network off. The served PDFs (/docs/) and the PDF library (/pdf-worker/) load only when a reader opens
// or the user saves a document. Viewing a document keeps nothing - the service worker passes it without
// storing it - and only an explicit save keeps one, together with the library that draws its pages. Unit tests pin each piece with injected caches; these run the real service worker, the
// real Cache API and the real PDF library, which is the only place the pieces meet.
//
// Offline here is `context.setOffline` on a page that stays loaded, except in the two @slow tests, which
// must load the app again with the network off to prove the model and the answer library came from the
// device rather than from memory.

// Both under 0.2 MB and two pages, so a test downloads little and draws its first page fast.
const VET_CENTERS = 'TAP - Vet Centers (Resource Guide)';
const HOME_LOAN = 'TAP - VA Home Loan Guaranty Program (Resource Guide)';

const NOT_SAVED_NOTICE =
	'This document is not saved on this device. Save it for offline use when you have a connection.';

// Mirrors ASK_ASSET_CACHE in src/lib/ask/asset-cache.ts: the model, the WASM, the corpus, the PDF library and
// every saved document live in this one cache.
const ASSET_CACHE = 'ask-assets-v1';

// Chromium only for the tests that need the service worker to answer with the network off. Under Playwright's
// WebKit, `context.setOffline(true)` fails every request from a page the worker controls before the worker can
// answer it. Probed with three requests offline: Chromium answered 200, 200 and the worker's own 503, while
// WebKit rejected all three with "TypeError: Load failed" - a precached /_app/immutable/ file included - so no
// offline load can pass there whatever the app does. These run on Chromium; real iOS Safari is covered by the
// release gate's device smoke.
const WEBKIT_OFFLINE_GAP =
	'Playwright WebKit offline fails a worker-controlled request before the worker can answer it';

/**
 * Wait until the service worker controls this page, so every later fetch passes through it.
 *
 * @param page The page to wait on.
 */
async function waitForServiceWorkerControl(page: Page): Promise<void> {
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
}

/** A document's row on /documents, found by its title whichever group it sits in. */
function documentRow(page: Page, title: string): Locator {
	return page
		.locator('li.doc-row')
		.filter({ has: page.getByRole('button', { name: title, exact: true }) });
}

/**
 * Assert the reader shows the document's first page drawn on a canvas, not the text it falls back to.
 *
 * @param reader The open reader dialog.
 */
async function expectFirstPageDrawn(reader: Locator): Promise<void> {
	const firstPage = reader.getByRole('img', { name: /^Page 1 of / });
	const fallback = reader.locator('.reader__notice');
	// Whichever the reader settles on: the page, or the text view's notice saying why it could not have it.
	await expect(firstPage.or(fallback)).toBeVisible({ timeout: 30_000 });
	// Read out as text, so a fallback fails with the reader's own words rather than a bare count.
	expect(await fallback.allTextContents()).toEqual([]);
	// A page keeps its number placeholder until its canvas has finished drawing.
	await expect(firstPage.locator('.pdf__num')).toHaveCount(0, { timeout: 30_000 });
	const width = await firstPage
		.locator('canvas')
		.evaluate((canvas) => (canvas as HTMLCanvasElement).width);
	expect(width).toBeGreaterThan(0);
}

/** The pathnames held in the asset cache. */
async function heldAssets(page: Page): Promise<string[]> {
	return page.evaluate(
		async (cacheName) =>
			(await (await caches.open(cacheName)).keys()).map((request) => new URL(request.url).pathname),
		ASSET_CACHE
	);
}

test('a passive visit fetches no document and no PDF library; opening one fetches and draws it', async ({
	page,
	context
}) => {
	test.setTimeout(90_000);
	// On the context, not the page: in Chromium that also records the service worker's own fetches, so a
	// document or library slipped into the install-time precache is caught too, not just a page fetch.
	const fetched: string[] = [];
	context.on('request', (request) => fetched.push(new URL(request.url()).pathname));
	const heavy = () =>
		fetched.filter((path) => path.startsWith('/docs/') || path.startsWith('/pdf-worker/'));

	await page.goto('/');
	// Activated means the install's precache has run in full.
	const state = await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		if (!reg.active) return 'no-active-worker';
		return new Promise<string>((resolve) => {
			const check = () => {
				if (reg.active?.state === 'activated') resolve('activated');
			};
			reg.active!.addEventListener('statechange', check);
			check();
		});
	});
	expect(state).toBe('activated');
	await page.waitForLoadState('networkidle');

	await page.goto('/documents');
	await expect(page.getByText('0 of 21 saved on this device - 0.0 MB')).toBeVisible();
	await page.waitForLoadState('networkidle');
	expect(heavy()).toEqual([]);

	// The same recorder sees the reader's downloads, so the empty list above is not a recorder that saw nothing.
	await page.getByRole('button', { name: VET_CENTERS, exact: true }).click();
	await expectFirstPageDrawn(page.getByRole('dialog', { name: VET_CENTERS }));
	expect(heavy().some((path) => path.startsWith('/docs/tap_vet_centers.'))).toBe(true);
	expect(heavy().some((path) => path.startsWith('/pdf-worker/'))).toBe(true);
});

// The only end-to-end proof that the service worker no longer keeps a document it merely passes.
test('a document only viewed is not kept: offline it opens to the text with the not-saved notice', async ({
	page,
	context
}) => {
	test.setTimeout(90_000);
	await page.goto('/documents');
	// Control first, so the view below passes through the service worker - the path under test.
	await waitForServiceWorkerControl(page);

	await page.getByRole('button', { name: VET_CENTERS, exact: true }).click();
	const reader = page.getByRole('dialog', { name: VET_CENTERS });
	await expectFirstPageDrawn(reader);
	// The Text view loads the answer library into the page, so the offline text view below has real text.
	await reader.getByRole('button', { name: 'Text' }).click();
	await expect(reader.getByText(/Vet Centers are community-based counseling centers/)).toBeVisible({
		timeout: 30_000
	});
	await reader.getByRole('button', { name: 'Close' }).click();
	await expect(reader).toBeHidden();
	expect((await heldAssets(page)).filter((path) => path.startsWith('/docs/'))).toEqual([]);

	await context.setOffline(true);
	await page.getByRole('button', { name: VET_CENTERS, exact: true }).click();
	await expect(reader.getByText(NOT_SAVED_NOTICE)).toBeVisible();
	await expect(reader.getByRole('button', { name: 'Text' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(reader.getByRole('button', { name: 'Page', exact: true })).toBeDisabled();
	await expect(
		reader.getByText(/Vet Centers are community-based counseling centers/)
	).toBeVisible();
	await expect(reader.getByRole('img', { name: /^Page \d+ of / })).toHaveCount(0);
	await expect(reader.locator('canvas')).toHaveCount(0);
});

test('a document saved from the reader opens on its page with the network off', async ({
	page,
	context,
	browserName
}) => {
	test.skip(browserName === 'webkit', WEBKIT_OFFLINE_GAP);
	test.setTimeout(90_000);
	await page.goto('/documents');
	// Control first, so the PDF library the view loads is kept by the worker for the offline open below.
	await waitForServiceWorkerControl(page);

	await page.getByRole('button', { name: VET_CENTERS, exact: true }).click();
	const reader = page.getByRole('dialog', { name: VET_CENTERS });
	await expectFirstPageDrawn(reader);
	await reader.getByRole('button', { name: 'Save for offline (0.1 MB)' }).click();
	await expect(reader.getByText('Saved on this device')).toBeVisible({ timeout: 30_000 });
	await reader.getByRole('button', { name: 'Close' }).click();
	await expect(reader).toBeHidden();

	await context.setOffline(true);
	await page.getByRole('button', { name: VET_CENTERS, exact: true }).click();
	await expectFirstPageDrawn(reader);
	await expect(reader.getByRole('button', { name: 'Page', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(reader.getByText('Saved on this device')).toBeVisible();
});

test('a document saved from its Documents row opens on its page with the network off', async ({
	page,
	context,
	browserName
}) => {
	test.skip(browserName === 'webkit', WEBKIT_OFFLINE_GAP);
	test.setTimeout(90_000);
	await page.goto('/documents');
	await waitForServiceWorkerControl(page);

	const row = documentRow(page, HOME_LOAN);
	await row.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Saved (1)' })).toBeVisible({ timeout: 30_000 });
	await expect(row.getByText('Saved', { exact: true })).toBeVisible();
	await expect(page.getByText('1 of 21 saved on this device - 0.2 MB')).toBeVisible();

	await context.setOffline(true);
	await page.getByRole('button', { name: HOME_LOAN, exact: true }).click();
	await expectFirstPageDrawn(page.getByRole('dialog', { name: HOME_LOAN }));
});

test('Settings shows the documents row to a visitor with no profile and leads to the Documents page', async ({
	page
}) => {
	await page.goto('/settings');
	await expect(page.getByRole('heading', { level: 2, name: 'Documents' })).toBeVisible();
	await expect(page.getByText('0 of 21 saved on this device - 0.0 MB')).toBeVisible();
	// The fixture is what it claims: no timeline, so every profile section is absent.
	await expect(page.getByRole('heading', { name: 'Transition timeline' })).toHaveCount(0);

	await page.getByRole('link', { name: 'Manage documents' }).click();
	await expect(page).toHaveURL(/\/documents$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
	await expect(page.getByText('0 of 21 saved on this device - 0.0 MB')).toBeVisible();
});

// An update leaves the older copy of a document the user saved. Both places that count what the device holds
// count it, sized from the device itself, and its row removes it.
test('Settings and the Documents page count an older copy an update left, and its row removes it', async ({
	page
}) => {
	await page.goto('/settings');
	await page.evaluate(async (cacheName) => {
		const cache = await caches.open(cacheName);
		await cache.put('/docs/tap_vet_centers.0badc0de.pdf', new Response(new Uint8Array(250_000)));
	}, ASSET_CACHE);
	await page.reload();
	const clause = '0 of 21 saved on this device - 0.0 MB, plus 1 older copy (0.3 MB)';
	await expect(page.getByText(clause)).toBeVisible();

	await page.getByRole('link', { name: 'Manage documents' }).click();
	await expect(page.getByText(clause)).toBeVisible();
	const row = documentRow(page, VET_CENTERS);
	await expect(row.getByText('Updated - the new version is not saved')).toBeVisible();
	await row.getByRole('button', { name: 'Remove', exact: true }).click();
	await expect(
		page.getByText('0 of 21 saved on this device - 0.0 MB', { exact: true })
	).toBeVisible();
	expect(await heldAssets(page)).not.toContain('/docs/tap_vet_centers.0badc0de.pdf');
});

// Heavy for the reason ask-offline.e2e.ts is (the real ~45 MB model), so @slow and out of the default run.
test('removing all saved documents keeps the on-device model and the answer library @slow', async ({
	page,
	context,
	browserName
}) => {
	test.skip(browserName === 'webkit', WEBKIT_OFFLINE_GAP);
	test.setTimeout(240_000);
	await page.goto('/');
	await waitForServiceWorkerControl(page);
	// Reload under control so the worker keeps Home, which the offline visit below loads again.
	await page.reload();

	const input = page.getByLabel('Ask a question');
	await expect(input).toBeEnabled({ timeout: 30_000 });
	await page.getByRole('button', { name: /^on device$/i }).click();
	await input.fill('what is SkillBridge and how long does it last?');
	await page.getByRole('button', { name: 'Search' }).click();
	await page.getByRole('button', { name: /set up.+answer/i }).click();
	await expect(page.locator('.ask-card--lead')).toBeVisible({ timeout: 150_000 });

	await page.goto('/documents');
	const row = documentRow(page, VET_CENTERS);
	await row.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Saved (1)' })).toBeVisible({ timeout: 30_000 });

	await page.getByRole('button', { name: 'Remove all saved documents' }).click();
	await page
		.getByRole('dialog', { name: 'Remove all saved documents?' })
		.getByRole('button', { name: 'Remove 1 document' })
		.click();
	await expect(page.getByText('0 of 21 saved on this device - 0.0 MB')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Not saved (21)' })).toBeVisible();
	await expect(row.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

	// The documents went, and nothing else did.
	const held = await heldAssets(page);
	expect(held.filter((path) => path.startsWith('/docs/'))).toEqual([]);
	expect(held.some((path) => path.startsWith('/models/'))).toBe(true);
	expect(held.some((path) => path.startsWith('/corpus/'))).toBe(true);

	// A fresh load with the network off: the model and the answer library can come only from the device.
	await context.setOffline(true);
	await page.goto('/');
	await expect(input).toBeEnabled({ timeout: 30_000 });
	await page.getByRole('button', { name: /^on device$/i }).click();
	expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
	await input.fill('how can I enroll in VA health care?');
	await page.getByRole('button', { name: 'Search' }).click();
	await expect(page.locator('.ask-card--lead')).toBeVisible({ timeout: 90_000 });
});

// Needs the on-device model: offline, answers come only from it.
test('the text reader works offline for a web-page source and for a PDF source @slow', async ({
	page,
	context,
	browserName
}) => {
	test.skip(browserName === 'webkit', WEBKIT_OFFLINE_GAP);
	test.setTimeout(240_000);
	// The test checks each lead card's title before reading it, so a ranking change fails here by name rather
	// than quietly exercising the other kind of source. The web question is pinned to its page. The PDF one
	// only has to lead with a served document: every "TAP - " source is one of the 21 served PDFs and none of
	// the web pages is, so the prefix is the kind of source, not a guess at which guide ranks first.
	const WEB_QUESTION = 'How do I submit an intent to file a VA claim?';
	const WEB_TITLE = 'VA - Your Intent to File a VA Claim';
	const PDF_QUESTION = 'are Vet Centers actually free and confidential or will it go on my record';

	await page.goto('/');
	await waitForServiceWorkerControl(page);
	await page.reload();
	const input = page.getByLabel('Ask a question');
	await expect(input).toBeEnabled({ timeout: 30_000 });
	await page.getByRole('button', { name: /^on device$/i }).click();
	await input.fill(WEB_QUESTION);
	await page.getByRole('button', { name: 'Search' }).click();
	await page.getByRole('button', { name: /set up.+answer/i }).click();
	await expect(page.locator('.ask-card--lead')).toBeVisible({ timeout: 150_000 });

	await context.setOffline(true);
	await page.reload();
	await expect(input).toBeEnabled({ timeout: 30_000 });
	await page.getByRole('button', { name: /^on device$/i }).click();

	// A web page: text only, and the reader says why there is no page to open.
	await input.fill(WEB_QUESTION);
	await page.getByRole('button', { name: 'Search' }).click();
	const lead = page.locator('.ask-card--lead');
	await expect(lead.locator('.ask-card__title')).toHaveText(WEB_TITLE, { timeout: 90_000 });
	await lead.getByRole('button', { name: 'Read more' }).click();
	const webReader = page.getByRole('dialog', { name: WEB_TITLE });
	await expect(
		webReader.getByText(/This source is a web page, so there is no document to open here/)
	).toBeVisible();
	await expect(webReader.getByRole('group', { name: 'Cited passage' })).toBeVisible();
	await expect(webReader.getByRole('button', { name: 'Page', exact: true })).toHaveCount(0);
	await webReader.getByRole('button', { name: 'Close' }).click();
	await expect(webReader).toBeHidden();

	// A PDF never saved: straight to its text, with the notice and the page switch disabled.
	await input.fill(PDF_QUESTION);
	await page.getByRole('button', { name: 'Search' }).click();
	await expect(lead.locator('.ask-card__title')).toHaveText(/^TAP - /, { timeout: 90_000 });
	const pdfTitle = await lead.locator('.ask-card__title').innerText();
	await lead.getByRole('button', { name: 'Read more' }).click();
	const pdfReader = page.getByRole('dialog', { name: pdfTitle });
	await expect(pdfReader.getByText(NOT_SAVED_NOTICE)).toBeVisible();
	await expect(pdfReader.getByRole('button', { name: 'Text' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(pdfReader.getByRole('button', { name: 'Page', exact: true })).toBeDisabled();
	await expect(pdfReader.getByRole('group', { name: 'Cited passage' })).toBeVisible();
	await expect(pdfReader.locator('canvas')).toHaveCount(0);
});

// A phone turned sideways is short. The reader fills the screen and only the title bar and the page bar stay
// pinned, so the pages get the height and Close stays in reach. The foot sits above the document, a scroll back up.
test('a short screen gives the pages the height and keeps Close and the foot within reach', async ({
	page
}) => {
	await page.setViewportSize({ width: 844, height: 390 });
	await page.goto('/documents');
	await page.getByRole('button', { name: VET_CENTERS, exact: true }).click();
	const reader = page.getByRole('dialog', { name: VET_CENTERS });
	await expectFirstPageDrawn(reader);

	const body = reader.locator('.reader__body');
	expect(await body.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(250);
	await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
	await expect(reader.getByRole('button', { name: 'Close' })).toBeInViewport();
	await expect(reader.getByRole('navigation', { name: 'Pages' })).toBeInViewport();
	await body.evaluate((el) => (el.scrollTop = 0));
	await expect(reader.getByRole('link', { name: 'View on the official site' })).toBeInViewport();
});

// A phone turned while reading: every page takes the new width, and the reader stays on the page they were on,
// the page bar naming it. WebKit, the iPhone's engine, keeps no place of its own for a scroll whose pages change
// size, so the page view keeps it; both engines are held to it here.
test('keeps the page in view when the phone turns, both ways', async ({ page }) => {
	const RESERVE = 'TAP - VA Benefits for Reserve and National Guard (Resource Guide)';
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/documents');
	await page.getByRole('button', { name: RESERVE, exact: true }).click();
	const reader = page.getByRole('dialog', { name: RESERVE });
	await expectFirstPageDrawn(reader);
	// No scroll anchoring from the engine, as on an iPhone: the place kept is the page view's own.
	await reader.locator('.reader__body').evaluate((body) => (body.style.overflowAnchor = 'none'));
	const number = reader.getByRole('spinbutton', { name: 'Page number' });
	// The page on the reading line a third of the way down the view, as the page bar reads it.
	const inView = () =>
		reader.locator('.reader__body').evaluate((body) => {
			const line = body.getBoundingClientRect().top + body.clientHeight / 3;
			let n = 1;
			for (const el of body.querySelectorAll('[data-page]')) {
				if (el.getBoundingClientRect().top <= line) n = Number((el as HTMLElement).dataset.page);
			}
			return n;
		});

	await number.fill('6');
	await number.press('Enter');
	await number.blur();
	await expect.poll(inView).toBe(6);
	await expect(number).toHaveValue('6');

	await page.setViewportSize({ width: 844, height: 390 });
	await expect(reader.locator('.reader__body .reader__foot')).toBeAttached();
	await expect.poll(inView).toBe(6);
	await expect(number).toHaveValue('6');

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(reader.locator('.reader__body .reader__foot')).not.toBeAttached();
	await expect.poll(inView).toBe(6);
	await expect(number).toHaveValue('6');
});
