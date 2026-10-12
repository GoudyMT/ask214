import { expect, test, type Page } from '@playwright/test';

// A calendar record that cannot be read is told apart from one still loading: Settings says the calendar settings could
// not be loaded and keeps adding off, instead of staying on "Loading" for good.
const LINE =
	'Your calendar settings could not be loaded, so adding is unavailable right now. Reload the app to try again.';

// The store verifies the check value before reading anything, so a row whose value fails reads as damage on disk.
function damageCalendarRecord(page: Page): Promise<void> {
	return page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const req = indexedDB.open('mtc');
				req.onerror = () => reject(new Error('E_TEST_OPEN'));
				req.onsuccess = () => {
					const db = req.result;
					const tx = db.transaction('calendar-sync-hwm', 'readwrite');
					tx.objectStore('calendar-sync-hwm').put({
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
}

function removeDamage(page: Page): Promise<void> {
	return page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const req = indexedDB.open('mtc');
				req.onerror = () => reject(new Error('E_TEST_OPEN'));
				req.onsuccess = () => {
					const db = req.result;
					const tx = db.transaction('calendar-sync-hwm', 'readwrite');
					tx.objectStore('calendar-sync-hwm').delete(0);
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => reject(new Error('E_TEST_WRITE'));
				};
			})
	);
}

test('a calendar record that cannot be read says so in Settings and keeps adding off, until it reads again', async ({
	page
}) => {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

	await damageCalendarRecord(page);
	await page.goto('/settings');

	await expect(page.getByText(LINE)).toBeVisible();
	await expect(page.getByRole('button', { name: /^customize what's included/i })).toContainText(
		'Unavailable'
	);
	await expect(page.getByRole('button', { name: 'Add to my calendar' })).toBeDisabled();

	// Once the record reads again (here: the bad one removed, so nothing saved yet), a reload brings the add back.
	await removeDamage(page);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Add to my calendar' })).toBeEnabled();
	await expect(page.getByText(LINE)).toHaveCount(0);
});
