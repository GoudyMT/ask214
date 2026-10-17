import { expect, type BrowserContext, type Page } from '@playwright/test';

// The steps the backup end-to-end specs share. Each restore runs the real key derivation (about 1.5 s in Chromium), so
// a spec that restores marks itself slow.

// The path sealApi proves its route with, for a spec that compares `reached` against it.
export const CONTROL_PATH = '/api/e2e-control';

export type Sealed = { reached: string[] };

// Nothing in these flows talks to the server; anything that tried would be a bug and must not reach a live endpoint
// (the mail key in the dev setup is real). The route is proven first by a request to a path no server answers, which
// has to be refused here; `reached` then lists every /api/ request that got as far as the route.
export async function sealApi(context: BrowserContext, page: Page): Promise<Sealed> {
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
export async function useInMemoryFiles(context: BrowserContext): Promise<void> {
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

export async function workerInCharge(page: Page): Promise<void> {
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

export async function setUpTimeline(page: Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

export type Backup = { name: string; text: string; words: string };

// Settings -> Make a backup, up to the point of pressing the form's own button: the six words are shown and typed in.
// Returns the words.
export async function startBackup(page: Page): Promise<string> {
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
	await page.locator('form[aria-label="Make a backup"] input[type=password]').fill(words);
	return words;
}

// Settings -> Make a backup, to the in-memory save. Returns the file and the six words that open it.
export async function makeBackup(page: Page): Promise<Backup> {
	const words = await startBackup(page);
	await page
		.locator('form[aria-label="Make a backup"]')
		.getByRole('button', { name: 'Make a backup' })
		.click();
	await expect(page.locator('.backup-result')).toBeVisible({ timeout: 60_000 });
	const saved = await page.evaluate(
		() => (window as unknown as { __saved?: { name: string; text: string } }).__saved
	);
	if (!saved) throw new Error('E_TEST_NO_BACKUP');
	return { ...saved, words };
}

export async function feedFile(page: Page, backup: Backup): Promise<void> {
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
export async function restoreOpenRow(page: Page, backup: Backup): Promise<void> {
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

// The key record is fine and the profile's mark fails its own check, as damage on disk would: the app starts on the
// damaged view.
export async function damageProfileMark(page: Page): Promise<void> {
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
