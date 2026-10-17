import { expect, test, type Page } from '@playwright/test';
import { SET_UP_FILES } from '../../src/lib/ask/asset-cache';
import { KDF_WORKER_SRC } from '../../src/lib/backup/kdf-paths';
import {
	CONTROL_PATH,
	damageProfileMark,
	feedFile,
	makeBackup,
	restoreOpenRow,
	sealApi,
	setUpTimeline,
	useInMemoryFiles,
	workerInCharge
} from './helpers/backup';

// The backup features on the paths only the BUILT app, served, with its service worker in charge, can show: no
// connection at all, a device whose saved data is damaged, and a page left open across a release. Each restore runs
// the real key derivation (about 1.5 s in Chromium), so the rows that restore are marked slow.
//
// Chromium only. Under Playwright's WebKit, `context.setOffline(true)` fails every request from a page the worker
// controls before the worker can answer it, so no offline page can load there whatever the app does (the same limit
// offline-pages.e2e.ts states). Real iOS Safari is covered by the release gate's device smoke.
test.skip(
	({ browserName }) => browserName === 'webkit',
	'Playwright WebKit offline fails a worker-controlled request before the worker can answer it'
);

// What the page asked the network for, by path, so a test can say what a flow did NOT fetch.
function recordRequests(page: Page): string[] {
	const paths: string[] = [];
	page.on('request', (request) => paths.push(new URL(request.url()).pathname));
	return paths;
}

async function assetCachePaths(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const paths: string[] = [];
		for (const request of await (await caches.open('ask-assets-v1')).keys())
			paths.push(new URL(request.url).pathname);
		return paths;
	});
}

test('a backup made and restored offline needs no Ask setup', async ({ page, context }) => {
	test.slow();
	await useInMemoryFiles(context);
	const { reached } = await sealApi(context, page);
	await workerInCharge(page);
	await setUpTimeline(page);
	// No Ask setup on this device: none of the files a finished setup holds, and none asked for.
	expect(await assetCachePaths(page)).toEqual([]);

	// The key worker's script has never been asked for: only the install of the app can have kept it.
	await context.setOffline(true);
	const requested = recordRequests(page);
	const response = await page.goto('/settings');
	expect(response?.fromServiceWorker()).toBe(true);
	const backup = await makeBackup(page);

	await page.getByRole('button', { name: 'Restore from a backup' }).click();
	await restoreOpenRow(page, backup);

	for (const path of requested) {
		expect(path, 'nothing of the offline library or the answer service is fetched').not.toMatch(
			/^\/(models|corpus|api)\//
		);
	}
	expect(requested).toContain(KDF_WORKER_SRC);
	expect(await assetCachePaths(page)).toEqual([]);
	for (const file of SET_UP_FILES) expect(requested).not.toContain(file);
	expect(reached).toEqual([CONTROL_PATH]);
});

test('an Erase made offline, then a restore on the first-run screen', async ({ page, context }) => {
	test.slow();
	await useInMemoryFiles(context);
	const { reached } = await sealApi(context, page);
	await workerInCharge(page);
	await setUpTimeline(page);
	await context.setOffline(true);
	await page.goto('/settings');
	const backup = await makeBackup(page);

	await page.getByRole('button', { name: /erase all data on this device/i }).click();
	const reloaded = page.waitForEvent('load', { timeout: 15_000 });
	await page.getByRole('button', { name: /^erase everything$/i }).click();
	await reloaded;
	await expect(page.getByText('Apr 15, 2027')).toBeHidden();

	// The first-run screen, opened offline, with nothing on the device.
	const response = await page.goto('/wizard');
	expect(response?.fromServiceWorker()).toBe(true);
	await expect(page.getByRole('heading', { level: 1, name: 'Set up your profile' })).toBeVisible();
	await page.getByRole('button', { name: 'Moving to a new phone? Restore from a backup' }).click();
	await restoreOpenRow(page, backup);
	expect(reached).toEqual([CONTROL_PATH]);
});

test('a damaged device: Check, Erase, then the restore row on /wizard', async ({
	page,
	context
}) => {
	test.slow();
	await useInMemoryFiles(context);
	const { reached } = await sealApi(context, page);
	await workerInCharge(page);
	await setUpTimeline(page);
	await page.goto('/settings');
	const backup = await makeBackup(page);

	await context.setOffline(true);
	await damageProfileMark(page);
	await page.reload();
	await expect(page.getByRole('alert')).toContainText("can't be read");
	await page.getByRole('alert').getByRole('link', { name: 'Settings' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Privacy and security' })).toBeVisible();

	// Check the backup first: on a damaged device it still opens, offline, with the real key derivation.
	const checkRow = page.getByRole('button', { name: 'Check a backup' });
	await expect(checkRow).toBeVisible();
	await checkRow.click();
	await feedFile(page, backup);
	const check = page.locator('form[aria-label="Check a backup"]');
	await check.locator('input[type=password]').fill(backup.words);
	await check.getByRole('button', { name: 'Check', exact: true }).click();
	await expect(page.locator('.backup-result')).toContainText('This backup opens. Made on', {
		timeout: 30_000
	});

	await page.getByRole('button', { name: /erase all data on this device/i }).click();
	await page.getByRole('button', { name: /^erase everything$/i }).click();

	// The Erase reloads onto the setup screen with the restore row already open, and nothing in the address says so.
	await expect(page).toHaveURL(/\/wizard$/, { timeout: 15_000 });
	await expect(page.getByRole('button', { name: 'Choose file' })).toBeVisible({ timeout: 15_000 });
	await restoreOpenRow(page, backup);
	expect(reached).toEqual([CONTROL_PATH]);
});

// A page left open across a release asks for a key worker whose folder the new release no longer has. The release
// changes the hashed folder; here the same request is answered 404 and the old copy is dropped from the worker's cache,
// which is what a new release's worker leaves behind.
test("a stale tab's worker load says the app was updated", async ({ page, context }) => {
	await useInMemoryFiles(context);
	const { reached } = await sealApi(context, page);
	await workerInCharge(page);
	await setUpTimeline(page);
	await page.goto('/settings');
	// The file is gone from the network first, so a copy of the worker that is still installing cannot store it again.
	await context.route('**' + KDF_WORKER_SRC, (route) =>
		route.fulfill({ status: 404, body: 'gone' })
	);
	await expect
		.poll(() =>
			page.evaluate(
				async () => (await navigator.serviceWorker.getRegistration())?.installing === null
			)
		)
		.toBe(true);
	const stillKept = await page.evaluate(async (path) => {
		let kept = 0;
		for (const name of await caches.keys()) {
			const cache = await caches.open(name);
			await cache.delete(path);
			if (await cache.match(path)) kept++;
		}
		return kept;
	}, KDF_WORKER_SRC);
	expect(stillKept).toBe(0);

	await page.getByRole('button', { name: 'Make a backup' }).click();
	await page.getByRole('button', { name: 'Show my passphrase' }).click();
	await expect(page.getByText('Ask 214 updated. Reload the page, then try again.')).toBeVisible();
	await expect(page.getByText(/The backup step stopped/)).toHaveCount(0);
	expect(reached).toEqual([CONTROL_PATH]);
});
