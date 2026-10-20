import { expect, test } from '@playwright/test';
import { feedFile, makeBackup, setUpTimeline, useInMemoryFiles } from './helpers/backup';

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
	await useInMemoryFiles(context);

	await setUpTimeline(page);

	await page.goto('/settings');
	const backup = await makeBackup(page);

	await page.getByRole('button', { name: 'Restore from a backup' }).click();
	await feedFile(page, backup);
	const restore = page.locator('form[aria-label="Restore from a backup"]');
	await restore.locator('input[type=password]').fill(backup.words);
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
