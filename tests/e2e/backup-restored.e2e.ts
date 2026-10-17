import { expect, test } from '@playwright/test';

// A restore reloads the page onto the Timeline with a note in the history entry, and the Timeline tells the person it
// worked. The note has to survive the BUILT app's start-up, which rewrites the entry before any page runs; a unit test
// of the page cannot see that, so this runs the real flow: make a backup, restore it, and read the Timeline.

test('after a restore the Timeline says so once, and not after another reload', async ({
	page,
	context
}) => {
	test.slow();
	// Nothing in this flow talks to the server; anything that tried would be a bug, and must not reach a live endpoint.
	await context.route('**/api/**', (route) => route.abort());

	// The save and open pickers do not exist in every engine and cannot be driven. The save is kept in memory instead;
	// the open picker is removed so the card falls back to its file input, which a test can feed.
	await page.addInitScript(() => {
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

	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

	await page.goto('/settings');
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

	await page.getByRole('button', { name: 'Restore from a backup' }).click();
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Choose file' }).click();
	await (
		await chooser
	).setFiles({
		name: saved.name,
		mimeType: 'application/json',
		buffer: Buffer.from(saved.text)
	});
	const restore = page.locator('form[aria-label="Restore from a backup"]');
	await restore.locator('input[type=password]').fill(words);
	await restore.getByRole('button', { name: 'Restore' }).click();
	await page.locator('dialog[open]').getByRole('button', { name: 'Replace' }).click();

	const line = page.getByText(/^Backup restored \(made /);
	await expect(page).toHaveURL(/\/timeline$/, { timeout: 30_000 });
	await expect(line).toHaveCount(1, { timeout: 15_000 });

	// A reload of the page it landed on is a different visit: the note was spent.
	await page.reload();
	await expect(page.getByText(/^Anchored to /)).toBeVisible();
	await expect(line).toHaveCount(0);
});
