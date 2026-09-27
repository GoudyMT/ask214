import { expect, test, type Page } from '@playwright/test';
import { ASK_ASSET_CACHE } from '../../src/lib/ask/asset-cache';
import { DEVICE_FILES } from '../../src/lib/ask/device-files';

// The Ask is the home page now (ADR-022/024). /ask stays as a permanent redirect so old links land.
test('/ask redirects to the home page', async ({ page }) => {
	await page.goto('/ask');
	await expect(page).toHaveURL(/\/$/); // redirected to the root, not left on /ask
	// the home page IS the Ask - its defining control, the query input, is present
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeVisible();
});

test('the home page leads with the hero headline and the Ask input', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toContainText(/military transition/i);
	// the input is the hero action; it enables once the corpus (a small static asset) loads
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
});

test('the model is NOT downloaded on page load (soft opt-in)', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
	// The model downloads inside the embed worker, which exists only after the user agrees to set up on-device
	// answers. No worker on the page means nothing is downloading.
	expect(page.workers()).toEqual([]);
});

// A device carrying the old "downloaded" flag but none of the files - a download made before the service worker
// took charge, or files the browser deleted - must ask before downloading, not fetch the model unasked.
test('a device without the files asks before downloading, whatever an old flag says', async ({
	page,
	context
}) => {
	const workers: string[] = [];
	page.on('worker', (worker) => workers.push(worker.url()));
	const downloads: string[] = [];
	context.on('request', (request) => {
		const path = new URL(request.url()).pathname;
		if (/^\/(models|wasm)\//.test(path)) downloads.push(path);
	});
	await page.addInitScript(() => localStorage.setItem('mtc:ask:model-downloaded', '1'));
	await page.goto('/');
	const input = page.getByRole('textbox', { name: /ask a question/i });
	await expect(input).toBeEnabled();
	await page.getByRole('button', { name: /^on device$/i }).click();
	await input.fill('How do I apply for SkillBridge?');
	await page.getByRole('button', { name: /^search$/i }).click();
	await expect(page.getByText(/one-time setup to answer your question/i)).toBeVisible();
	// Asking is all it did: no embed worker, and nothing of the model or its runtime was fetched.
	expect(workers).toEqual([]);
	expect(downloads).toEqual([]);
});

// The other side: a device that keeps every on-device file is set up already, so asking on the device goes
// straight to the answer - no setup prompt, and the embed worker starts at once.
test('a device that keeps every on-device file answers without asking to set up', async ({
	page
}) => {
	const workers: string[] = [];
	page.on('worker', (worker) => workers.push(worker.url()));
	await page.goto('/');
	// Stand-ins at the on-device files' addresses: the page asks only whether each is kept, not what it holds.
	await page.evaluate(
		async ({ cacheName, paths }) => {
			const cache = await caches.open(cacheName);
			await Promise.all(paths.map((path) => cache.put(path, new Response('kept'))));
		},
		{ cacheName: ASK_ASSET_CACHE, paths: [...DEVICE_FILES] }
	);
	await page.reload();
	const input = page.getByRole('textbox', { name: /ask a question/i });
	await expect(input).toBeEnabled();
	await page.getByRole('button', { name: /^on device$/i }).click();
	await input.fill('How do I apply for SkillBridge?');
	await page.getByRole('button', { name: /^search$/i }).click();
	await expect.poll(() => workers.length, { timeout: 15_000 }).toBe(1);
	await expect(page.getByText(/one-time setup to answer your question/i)).toHaveCount(0);
});

test('asking in device mode on a fresh profile replaces the on-ramp with the setup prompt', async ({
	page
}) => {
	await page.goto('/');
	const input = page.getByRole('textbox', { name: /ask a question/i });
	await expect(input).toBeEnabled();
	// idle + no profile: the on-ramp is visible
	await expect(page.getByRole('heading', { name: /make it yours/i })).toBeVisible();
	// online is the on-ramp default, so switch to device to exercise the soft opt-in: device mode gates the
	// one-time download on the first query. The prompt takes the space; the on-ramp is gone.
	await page.getByRole('button', { name: /^on device$/i }).click();
	await input.fill('How do I apply for SkillBridge?');
	await page.getByRole('button', { name: /^search$/i }).click();
	await expect(page.getByText(/one-time setup to answer your question/i)).toBeVisible();
	await expect(page.getByRole('heading', { name: /make it yours/i })).toHaveCount(0);
});

test('a fresh profile reaches Settings for online answers, but the timeline sections stay hidden', async ({
	page
}) => {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
	// Settings is reachable now - the "Online answers" panel is always configurable...
	await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
	await page.goto('/settings');
	await expect(page).toHaveURL(/\/settings$/); // no redirect
	await expect(page.getByRole('heading', { name: /online answers/i })).toBeVisible();
	// ...but the timeline-dependent sections stay hidden until there is a timeline to manage - including the
	// "Privacy and security" lock, which protects encrypted profile data that does not exist yet (V1).
	await expect(page.getByRole('heading', { name: /transition timeline/i })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: /privacy and security/i })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Lock', exact: true })).toHaveCount(0);
	// With everything else hidden, the BYOK trust disclosure is the security surface a no-data user sees.
	await expect(page.getByText(/how is my key protected/i)).toBeVisible();
});

test('the mode toggle flips both ways and the question feed stays put (V2)', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
	const online = page.getByRole('button', { name: 'Online', exact: true });
	const onDevice = page.getByRole('button', { name: 'On device', exact: true });
	const feedPill = page.locator('.q-feed__pill').first();
	const privacy = page.locator('.ask-private');
	// on-ramp default is online, with the feed showing
	await expect(online).toHaveAttribute('aria-pressed', 'true');
	await expect(feedPill).toBeVisible();
	// -> on device: the toggle flips, the privacy line follows, the feed persists
	await onDevice.click();
	await expect(onDevice).toHaveAttribute('aria-pressed', 'true');
	await expect(privacy).toContainText(/on your device/i);
	await expect(feedPill).toBeVisible();
	// -> back to online: flips cleanly (no hang on device), egress copy returns, feed still there
	await online.click();
	await expect(online).toHaveAttribute('aria-pressed', 'true');
	await expect(privacy).toContainText(/only your question is sent/i);
	await expect(feedPill).toBeVisible();
});

// The page makes its Ask store only after it has read the cache, which can take up to its time limit. A choice made
// in that time is held and handed to the store, not lost. The page's cache reads are held here, so the store
// waits for the limit and every tap below lands before it exists.
async function holdCacheReads(page: Page): Promise<void> {
	await page.addInitScript(() => {
		caches.match = () => new Promise<Response | undefined>(() => {});
	});
}

test('a mode picked before the page is ready is kept', async ({ page }) => {
	await holdCacheReads(page);
	await page.goto('/');
	const search = page.getByRole('button', { name: /^search$/i });
	const onDevice = page.getByRole('button', { name: /^on device$/i });
	await expect(search).toBeDisabled(); // the premise: no store yet
	await onDevice.click();
	await expect(onDevice).toHaveAttribute('aria-pressed', 'true');

	await expect(search).toBeEnabled({ timeout: 10_000 });
	await expect(onDevice).toHaveAttribute('aria-pressed', 'true');
	await page
		.getByRole('textbox', { name: /ask a question/i })
		.fill('How do I apply for SkillBridge?');
	await search.click();
	// Asked on the device, so it offers the setup, not an online answer.
	await expect(page.getByText(/one-time setup to answer your question/i)).toBeVisible();
});

test('a question picked from the feed before the page is ready is asked once it is', async ({
	page
}) => {
	await holdCacheReads(page);
	// The feed drifts sideways unless motion is reduced, and a moving pill cannot be tapped reliably.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/');
	const search = page.getByRole('button', { name: /^search$/i });
	await expect(search).toBeDisabled(); // the premise: no store yet
	await page.locator('.q-feed__pill').first().click();

	await expect(search).toBeEnabled({ timeout: 10_000 });
	// Online is the default, so the question reaches the consent step for answering online.
	await expect(
		page.getByRole('heading', { name: /send your question to answer online/i })
	).toBeVisible();
});

// Taps made in one task while Search is still disabled - no store yet - so each lands before the store exists
// however slow the machine is. Returns whether that held when the taps were made.
async function tapBeforeReady(
	page: Page,
	targets: { selector: string; text?: string }[]
): Promise<boolean> {
	return page.evaluate((all) => {
		const early = (document.querySelector('button.ask-search') as HTMLButtonElement).disabled;
		for (const { selector, text } of all) {
			const target = [...document.querySelectorAll<HTMLElement>(selector)].find(
				(element) => text === undefined || element.textContent?.trim() === text
			);
			if (target === undefined) throw new Error('E_TAP_TARGET_MISSING');
			target.click();
		}
		return early;
	}, targets);
}

// A question held before the page is ready runs in the mode showing when it was picked, as it would with the page
// ready; a mode tapped after it applies to the next question and sends nothing. The saved default here is the
// device and online answers were agreed to before, so a question run in the later mode would go online at once.
test('a feed question picked before the page is ready runs in the mode it was picked in', async ({
	page,
	context
}) => {
	await page.addInitScript(() => {
		localStorage.setItem('mtc:ask:default-mode', 'device');
		localStorage.setItem('mtc:ask:online-consented', '1');
	});
	const sent: string[] = [];
	context.on('request', (request) => {
		const path = new URL(request.url()).pathname;
		if (path.startsWith('/api/')) sent.push(path);
	});
	await holdCacheReads(page);
	await page.goto('/');
	const search = page.getByRole('button', { name: /^search$/i });
	await expect(search).toBeDisabled();
	const early = await tapBeforeReady(page, [
		{ selector: '.q-feed__pill' },
		{ selector: '.ask-mode__opt', text: 'Online' }
	]);
	expect(early).toBe(true);

	await expect(search).toBeEnabled({ timeout: 10_000 });
	// Picked on the device, which keeps nothing: the setup is offered, and nothing went online.
	await expect(page.getByText(/one-time setup to answer your question/i)).toBeVisible();
	expect(sent).toEqual([]);
	// The later tap still counts, for the next question.
	await expect(page.getByRole('button', { name: 'Online', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('the Ask input is the first focusable control in the page content', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
	// Spec section 12: the input is the first tab stop. Asserted structurally (WebKit omits links from the
	// default Tab order, so a keypress probe is engine-dependent): the first focusable element inside
	// <main> is the Ask input, so nothing steals focus ahead of the hero action.
	const inputIsFirst = await page.evaluate(() => {
		const main = document.querySelector('main');
		const first = main?.querySelector(
			'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])'
		);
		return first instanceof HTMLElement && first.matches('input.ask-input');
	});
	expect(inputIsFirst).toBe(true);
});
