import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { SET_UP_FILES } from '../../src/lib/ask/asset-cache';
import { KDF_WORKER_SRC } from '../../src/lib/backup/kdf-paths';

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

const CONTROL_PATH = '/api/e2e-control';

type Sealed = { reached: string[] };

// Nothing in these flows talks to the server; anything that tried would be a bug and must not reach a live endpoint
// (the mail key in the dev setup is real). The route is proven first by a request to a path no server answers, which
// has to be refused here; `reached` then lists every /api/ request that got as far as the route.
async function sealApi(context: BrowserContext, page: Page): Promise<Sealed> {
	const reached: string[] = [];
	await context.route('**/api/**', (route) => {
		reached.push(new URL(route.request().url()).pathname);
		return route.abort();
	});
	await page.goto('/');
	const outcome = await page.evaluate(
		(path) =>
			fetch(path).then(
				() => 'reached the network',
				() => 'refused'
			),
		CONTROL_PATH
	);
	expect(outcome).toBe('refused');
	expect(reached).toEqual([CONTROL_PATH]);
	return { reached };
}

// The save and open pickers do not exist in every engine and cannot be driven. The save is kept in memory instead; the
// open picker is removed so the card falls back to its file input, which a test can feed.
async function useInMemoryFiles(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		const w = window as unknown as {
			showOpenFilePicker?: unknown;
			showSaveFilePicker?: unknown;
			__saved?: { name: string; text: string };
		};
		delete w.showOpenFilePicker;
		w.showSaveFilePicker = async (opts?: { suggestedName?: string }) => {
			const name = opts?.suggestedName ?? 'backup.ask214backup';
			let text = '';
			return {
				name,
				kind: 'file',
				createWritable: async () => {
					let buffered = '';
					return {
						write: async (d: unknown) => {
							buffered += typeof d === 'string' ? d : await new Blob([d as BlobPart]).text();
						},
						close: async () => {
							text = buffered;
							w.__saved = { name, text };
						},
						abort: async () => {}
					};
				},
				// The card reads the file back to prove what was saved.
				getFile: async () => new File([text], name, { type: 'application/json' })
			};
		};
	});
}

async function workerInCharge(page: Page): Promise<void> {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise<void>((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
					once: true
				})
			);
	});
}

async function setUpTimeline(page: Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

type Backup = { name: string; text: string; words: string };

// Settings -> Make a backup, to the in-memory save. Returns the file and the six words that open it.
async function makeBackup(page: Page): Promise<Backup> {
	await page.getByRole('button', { name: 'Make a backup' }).click();
	await page.getByRole('button', { name: 'Show my passphrase' }).click();
	const card = page.locator('.backup-card');
	await expect(card).toContainText('Write these words down');
	const lines = (await card.innerText())
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
	const at = lines.findIndex((s) => s.startsWith('Write these words down'));
	const words = lines.slice(at + 1, at + 7).join(' ');
	expect(words.split(' ')).toHaveLength(6);
	const make = page.locator('form[aria-label="Make a backup"]');
	await make.locator('input[type=password]').fill(words);
	await make.getByRole('button', { name: 'Make a backup' }).click();
	await expect(page.locator('.backup-result')).toBeVisible({ timeout: 60_000 });
	const saved = await page.evaluate(
		() => (window as unknown as { __saved?: { name: string; text: string } }).__saved
	);
	if (!saved) throw new Error('E_TEST_NO_BACKUP');
	return { ...saved, words };
}

async function feedFile(page: Page, backup: Backup): Promise<void> {
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Choose file' }).click();
	await (
		await chooser
	).setFiles({
		name: backup.name,
		mimeType: 'application/json',
		buffer: Buffer.from(backup.text)
	});
}

// The open row's file, the words and Replace; the page reloads onto the Timeline with the restored line.
async function restoreOpenRow(page: Page, backup: Backup): Promise<void> {
	await feedFile(page, backup);
	const restore = page.locator('form[aria-label="Restore from a backup"]');
	await restore.locator('input[type=password]').fill(backup.words);
	await restore.getByRole('button', { name: 'Restore' }).click();
	// The key is derived first, offline, by the worker the app kept: the confirm only opens once it has.
	const confirm = page.locator('dialog[open]');
	await expect(confirm).toBeVisible({ timeout: 30_000 });
	await confirm.getByRole('button', { name: 'Replace' }).click();
	await expect(page).toHaveURL(/\/timeline$/, { timeout: 30_000 });
	await expect(page.getByText(/^Backup restored \(made /)).toHaveCount(1, { timeout: 15_000 });
	// The restored profile's date is what the Timeline is anchored to.
	await expect(page.getByText(/^Anchored to Apr 15, 2027/)).toBeVisible();
}

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

// The key record is fine and the profile's mark fails its own check, as damage on disk would: the app starts on the
// damaged view.
async function damageProfileMark(page: Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const req = indexedDB.open('mtc');
				req.onerror = () => reject(new Error('E_TEST_OPEN'));
				req.onsuccess = () => {
					const db = req.result;
					const tx = db.transaction('profile-hwm', 'readwrite');
					const store = tx.objectStore('profile-hwm');
					const get = store.get(0);
					get.onsuccess = () => {
						const row = get.result;
						const mac = new Uint8Array(row.mac.slice(0));
						mac[0] = (mac[0] ?? 0) ^ 0xff;
						row.mac = mac.buffer;
						store.put(row);
					};
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => reject(new Error('E_TEST_WRITE'));
				};
			})
	);
}

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
