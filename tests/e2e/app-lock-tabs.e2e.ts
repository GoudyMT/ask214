import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// The PIN lock between real tabs of one browser context, which share IndexedDB and the cross-tab channel. Each key
// derive runs through the served build's real worker (about 1.5 s in Chromium, 2.5 s in WebKit). Every detail is made
// up. The service worker is blocked so every request comes from the page itself.
//
// Playwright cannot put a page in the browser's back/forward cache (bfcache.e2e.ts says the same), so a page "asleep
// in the cache" is made the way that cache leaves it: the page gets its pagehide, and it hears nothing from the other
// tabs because its cross-tab channel is silent, as a cached page's is.
test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

const PIN = '135790';
const MINUTE_MS = 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A made-up separation date far enough ahead that the Timeline anchors to it, built here because the E2E files share no
// helper module.
const separationDate = new Date();
separationDate.setDate(separationDate.getDate() + 300);
const pad = (n: number) => String(n).padStart(2, '0');
const SEPARATION = `${separationDate.getFullYear()}-${pad(separationDate.getMonth() + 1)}-${pad(separationDate.getDate())}`;
const SEPARATION_ON_SCREEN = `${MONTHS[separationDate.getMonth()]} ${separationDate.getDate()}, ${separationDate.getFullYear()}`;
const ANCHORED = `Anchored to ${SEPARATION_ON_SCREEN}`;

const lockedHeading = (page: Page) => page.getByRole('heading', { name: 'Your data is locked' });
const pinField = (page: Page) => page.getByLabel('PIN', { exact: true });
const appLockToggle = (page: Page) => page.getByRole('button', { name: /^app lock/i });
const lockButton = (page: Page) => page.getByRole('button', { name: 'Lock', exact: true });

async function setUpProfile(page: Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(SEPARATION);
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

async function turnOnPin(page: Page): Promise<void> {
	await page.goto('/settings');
	await appLockToggle(page).click();
	await page.getByLabel('Choose a 4-6 digit PIN').fill(PIN);
	await page.getByLabel('Enter it again').fill(PIN);
	await page.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(appLockToggle(page)).toContainText('PIN on', { timeout: 30_000 });
}

async function pressUnlock(page: Page): Promise<void> {
	await pinField(page).fill(PIN);
	await page.getByRole('button', { name: 'Unlock', exact: true }).click();
}

/** The app lock's durable lock counter, read straight from IndexedDB. */
async function readCounter(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			new Promise<number>((resolve, reject) => {
				const open = indexedDB.open('mtc');
				open.onerror = () => reject(new Error('E_TEST_OPEN'));
				open.onsuccess = () => {
					const db = open.result;
					const get = db.transaction('app-lock', 'readonly').objectStore('app-lock').get('counter');
					get.onerror = () => reject(new Error('E_TEST_READ'));
					get.onsuccess = () => {
						db.close();
						resolve((get.result as { value: number } | undefined)?.value ?? 0);
					};
				};
			})
	);
}

// Both tabs hold the PIN's keys: the first turned it on, the second typed it.
async function twoUnlockedTabs(context: BrowserContext): Promise<{
	first: Page;
	second: Page;
}> {
	const first = await context.newPage();
	await setUpProfile(first);
	await turnOnPin(first);
	const second = await context.newPage();
	await second.goto('/settings');
	await pressUnlock(second);
	await expect(lockButton(second)).toBeVisible({ timeout: 30_000 });
	return { first, second };
}

// 6. The use: Lock in one tab must reach a tab that was not listening when it happened.
test('a Lock in one tab locks a tab that was asleep in the back/forward cache', async ({
	context
}) => {
	const tabB = await context.newPage();
	await setUpProfile(tabB);
	await turnOnPin(tabB);

	const tabA = await context.newPage();
	// Silent from the start: nothing the other tabs say reaches this one, and it says nothing.
	await tabA.addInitScript(() => {
		window.BroadcastChannel = class {
			postMessage(): void {}
			addEventListener(): void {}
			removeEventListener(): void {}
			close(): void {}
		} as unknown as typeof BroadcastChannel;
	});
	await tabA.goto('/settings');
	await pressUnlock(tabA);
	await expect(lockButton(tabA)).toBeVisible({ timeout: 30_000 });

	// Tab A leaves for the cache.
	await tabA.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
	);

	// Tab B locks. The signal it sends is the one a cached tab never hears; what is left is the durable counter.
	const before = await readCounter(tabB);
	await lockButton(tabB).click();
	await expect(lockedHeading(tabB)).toBeVisible();
	await expect.poll(() => readCounter(tabB)).toBeGreaterThan(before);

	// Back in tab A.
	await tabA.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
	);
	await expect(pinField(tabA)).toBeVisible();
	await expect(lockedHeading(tabA)).toBeVisible();
	await expect(lockButton(tabA)).toHaveCount(0);
	await expect(tabA.getByText(SEPARATION_ON_SCREEN)).toHaveCount(0);
});

// 7. The use: leaving one tab alone must not lock the one in use. With a PIN an idle lock stays in its own tab.
test('one tab idling for sixteen minutes does not lock a tab that is in use', async ({
	context
}) => {
	// Every message this context's tabs receive on the cross-tab channel, kept in the page.
	await context.addInitScript(() => {
		const Original = window.BroadcastChannel;
		const seen: unknown[] = [];
		(window as unknown as { __busSeen: unknown[] }).__busSeen = seen;
		window.BroadcastChannel = class extends Original {
			constructor(name: string) {
				super(name);
				this.addEventListener('message', (event) => seen.push((event as MessageEvent).data));
			}
		};
	});
	// Installed before any page loads, so the timers and both clocks of both tabs move together.
	await context.clock.install();
	const { first: tabA, second: tabB } = await twoUnlockedTabs(context);
	await expect(tabB.getByText(SEPARATION_ON_SCREEN)).toBeVisible();

	// Sixteen minutes pass. Tab B is touched every few minutes; tab A never is.
	for (const [touch, minutes] of [5, 5, 5, 1].entries()) {
		await tabB.mouse.move(40 + touch * 10, 40);
		await context.clock.runFor(minutes * MINUTE_MS);
	}

	// Tab A locked itself for idleness.
	await expect(pinField(tabA)).toBeVisible();
	await expect(lockedHeading(tabA)).toBeVisible();

	// Something tab A says after the idle lock is heard in tab B: whatever the idle lock sent has arrived before it.
	await tabA.evaluate(() => {
		const channel = new BroadcastChannel('mtc-profile');
		channel.postMessage({ type: 'timeline-updated' });
		channel.close();
	});
	const heard = () =>
		tabB.evaluate(() =>
			(window as unknown as { __busSeen: { type?: string }[] }).__busSeen.map((m) => m.type)
		);
	await expect.poll(heard).toContain('timeline-updated');
	expect(await heard()).not.toContain('relocked');

	await expect(tabB.getByText(SEPARATION_ON_SCREEN)).toBeVisible();
	await expect(lockButton(tabB)).toBeVisible();
	await expect(pinField(tabB)).toHaveCount(0);
	await expect(lockedHeading(tabB)).toHaveCount(0);
});

// 8. The use: a PIN turned on in one tab must not leave an open tab showing the data without it.
test('turning the PIN on in one tab shows the Unlock card in a tab opened without one', async ({
	context
}) => {
	const tabA = await context.newPage();
	await setUpProfile(tabA);

	const tabB = await context.newPage();
	await tabB.goto('/timeline');
	await expect(tabB.getByText(ANCHORED)).toBeVisible();
	await expect(pinField(tabB)).toHaveCount(0);

	await turnOnPin(tabA);

	// No reload in tab B: the key change reaches it, and it closes the data.
	await expect(lockedHeading(tabB)).toBeVisible();
	await expect(pinField(tabB)).toBeVisible();
	await expect(tabB.getByText(/Anchored to/)).toHaveCount(0);

	// And it read the new lock: the PIN chosen in the other tab opens it.
	await pressUnlock(tabB);
	await expect(tabB.getByText(ANCHORED)).toBeVisible({ timeout: 30_000 });
});
