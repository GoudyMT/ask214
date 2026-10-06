import { expect, test } from '@playwright/test';

// Regression coverage for the cross-tab profile broadcast (subscribeBus). Saving
// the profile in one tab fires a BroadcastChannel
// 'profile-updated' signal; other same-origin tabs re-load from IndexedDB and re-render.
// Both pages share ONE browser context, so they share IndexedDB and the BroadcastChannel.
// A publisher does not receive its own message (BroadcastChannel self-exclusion), so two
// real pages are required to observe propagation.

// A newer release raises the database version, and an app older than its database cannot open it. Instead of loading
// forever, it says so under the header and offers a reload, while the parts that need no saved data keep working.
test('an app older than its database says so and offers a reload, and Ask still works', async ({
	page
}) => {
	await page.goto('/');
	// The set-up link shows only once the app is ready, so its database is open at the app's own version by now; Ask
	// alone enables before that, and a raise that lands first is simply upgraded past.
	await expect(page.getByRole('link', { name: /set up your timeline/i })).toBeVisible();
	// Raise the database one version, as a newer release would; the app's own connection steps aside for it.
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const req = indexedDB.open('mtc');
				req.onerror = () => reject(new Error('E_TEST_OPEN'));
				req.onsuccess = () => {
					const version = req.result.version;
					req.result.close();
					const up = indexedDB.open('mtc', version + 1);
					up.onerror = () => reject(new Error('E_TEST_UPGRADE'));
					up.onblocked = () => reject(new Error('E_TEST_BLOCKED'));
					up.onsuccess = () => {
						up.result.close();
						resolve();
					};
				};
			})
	);
	await page.reload();
	await expect(
		page.getByText(
			"The app couldn't open the information saved on this device. Reload to try again."
		)
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeEnabled();
});

test('a saved EAOS propagates across tabs: IDB load + live broadcast update', async ({
	context
}) => {
	const tabA = await context.newPage();

	// Tab A: first-run wizard sets the initial EAOS, creating the encrypted profile.
	await tabA.goto('/wizard');
	await tabA.getByLabel(/separation date/i).fill('2027-04-15');
	await tabA.getByRole('button', { name: /save and continue/i }).click();
	await expect(tabA.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

	// Tab B: open Settings; it loads the stored EAOS from IndexedDB (cross-tab read).
	const tabB = await context.newPage();
	await tabB.goto('/settings');
	await expect(tabB.getByText('Apr 15, 2027')).toBeVisible();

	// Tab A: change the EAOS in Settings and save (fires the 'profile-updated' broadcast).
	await tabA.goto('/settings');
	await expect(tabA.getByText('Apr 15, 2027')).toBeVisible(); // store loaded -> the date shows as the disclosure summary
	await tabA.getByRole('button', { name: /separation date/i }).click();
	await tabA.getByLabel(/separation date/i).fill('2028-08-20');
	// Scope to the timeline section: Settings now also carries the BYO-key "Save" (Online answers).
	await tabA
		.getByLabel('Transition timeline')
		.getByRole('button', { name: /^save$/i })
		.click();

	// Tab B (no manual reload): broadcast -> store.load() -> persona -> the value re-renders.
	await expect(tabB.getByText('Aug 20, 2028')).toBeVisible();
	await expect(tabB.getByText('Apr 15, 2027')).toBeHidden();
});
