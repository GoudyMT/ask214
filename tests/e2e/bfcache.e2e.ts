import { expect, test } from '@playwright/test';

// Regression coverage for the Page-Lifecycle relock/restore wiring (installLifecycle).
// On `pagehide`/`freeze` the in-memory profile relocks (PII
// zeroized, store.locked -> true); on a persisted `pageshow` (the BFCache-restore signal) the
// store re-reads from IndexedDB. We dispatch the real lifecycle events on window (which the
// layout wires the handlers to) rather than relying on the browser's BFCache engine, which is
// environment-dependent and cannot be forced in Playwright. Real BFCache-engine behavior is
// covered by the manual cross-browser device-smoke launch gate.

test('page-lifecycle: pagehide relocks the profile, persisted pageshow restores it', async ({
	page
}) => {
	// Seed: first-run wizard creates the encrypted profile with an EAOS.
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Transition Companion' })).toBeVisible();

	// Settings shows the decrypted value (store loaded, unlocked).
	await page.goto('/settings');
	await expect(page.getByText('2027-04-15')).toBeVisible();

	// pagehide (page backgrounded / entering BFCache) -> relockSync: PII zeroized, store locked.
	await page.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
	);
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeVisible();
	await expect(page.getByText('2027-04-15')).toBeHidden();

	// Persisted pageshow (BFCache restore) -> store.load() re-decrypts from IDB; the value returns.
	await page.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
	);
	await expect(page.getByText('2027-04-15')).toBeVisible();
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeHidden();
});

test('page-lifecycle: freeze relocks the profile, resume restores it', async ({ page }) => {
	// A browser freezing a quiet background tab dispatches freeze and later resume, with no
	// navigation - so neither pagehide nor pageshow ever fires. Relocking on one without restoring
	// on the other leaves a blank page the user can only fix by reloading.
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Transition Companion' })).toBeVisible();

	await page.goto('/settings');
	await expect(page.getByText('2027-04-15')).toBeVisible();

	await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeVisible();
	await expect(page.getByText('2027-04-15')).toBeHidden();

	await page.evaluate(() => document.dispatchEvent(new Event('resume')));
	await expect(page.getByText('2027-04-15')).toBeVisible();
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeHidden();
});

test('page-lifecycle: an explicit Lock survives a background and restore', async ({ page }) => {
	// The ladder's whole purpose, end to end: pagehide relocks an already-locked store, and if that
	// hygiene relock could mark it restorable again, coming back would silently undo the Lock the
	// user asked for.
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Transition Companion' })).toBeVisible();

	await page.goto('/settings');
	await page.getByRole('button', { name: /^lock$/i }).click();
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeVisible();

	await page.evaluate(() => {
		window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
		window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
	});

	// Still locked. The restore may undo the app's own hygiene, never the user's decision.
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeVisible();
	await expect(page.getByText('2027-04-15')).toBeHidden();
});
