import { expect, test } from '@playwright/test';

// When the timeline's saved progress cannot be read, the Timeline says so in place of the list. A list drawn from nothing
// would show every task as not started while the progress is still on the device, and its buttons would do nothing.
test('a timeline whose saved progress cannot be read says so instead of showing every task as not started', async ({
	page
}) => {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

	// A progress record whose check value fails, as damage on disk would: the store verifies it before reading anything.
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const req = indexedDB.open('mtc');
				req.onerror = () => reject(new Error('E_TEST_OPEN'));
				req.onsuccess = () => {
					const db = req.result;
					const tx = db.transaction('timeline-state-hwm', 'readwrite');
					tx.objectStore('timeline-state-hwm').put({
						id: 0,
						v: 1,
						payload: { generation: 1, keystoreGeneration: 0, epoch: 0, ts: 0 },
						mac: new Uint8Array(32).buffer
					});
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => reject(new Error('E_TEST_WRITE'));
				};
			})
	);
	await page.reload();

	const note = page.getByRole('alert');
	await expect(note).toHaveText(
		"Your saved progress couldn't be loaded, so your tasks aren't shown. Reload to try again. If it keeps happening, you can erase all data in Settings and start again."
	);
	await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
	// The profile itself reads fine, so the Timeline still shows its separation date.
	await expect(page.getByText(/Anchored to Apr 15, 2027/)).toBeVisible();
});
