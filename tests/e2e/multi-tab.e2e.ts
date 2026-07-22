import { expect, test } from '@playwright/test';

// Regression coverage for the cross-tab profile broadcast (subscribeBus). Saving
// the profile in one tab fires a BroadcastChannel
// 'profile-updated' signal; other same-origin tabs re-load from IndexedDB and re-render.
// Both pages share ONE browser context, so they share IndexedDB and the BroadcastChannel.
// A publisher does not receive its own message (BroadcastChannel self-exclusion), so two
// real pages are required to observe propagation.

test('a saved EAOS propagates across tabs: IDB load + live broadcast update', async ({
	context
}) => {
	const tabA = await context.newPage();

	// Tab A: first-run wizard sets the initial EAOS, creating the encrypted profile.
	await tabA.goto('/wizard');
	await tabA.getByLabel(/separation date/i).fill('2027-04-15');
	await tabA.getByRole('button', { name: /save and continue/i }).click();
	await expect(tabA.getByRole('textbox', { name: /ask a question/i })).toBeVisible();

	// Tab B: open Settings; it loads the stored EAOS from IndexedDB (cross-tab read).
	const tabB = await context.newPage();
	await tabB.goto('/settings');
	await expect(tabB.getByText('2027-04-15')).toBeVisible();

	// Tab A: change the EAOS in Settings and save (fires the 'profile-updated' broadcast).
	await tabA.goto('/settings');
	await expect(tabA.getByText('2027-04-15')).toBeVisible(); // store loaded -> button is "Change"
	await tabA.getByRole('button', { name: /^change$/i }).click();
	await tabA.getByLabel(/separation date/i).fill('2028-08-20');
	await tabA.getByRole('button', { name: /^save$/i }).click();

	// Tab B (no manual reload): broadcast -> store.load() -> persona -> the value re-renders.
	await expect(tabB.getByText('2028-08-20')).toBeVisible();
	await expect(tabB.getByText('2027-04-15')).toBeHidden();
});
