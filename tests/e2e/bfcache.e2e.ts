import { expect, test } from '@playwright/test';

// Regression coverage for the Page-Lifecycle relock/restore wiring (installLifecycle).
//
// Three ways a page goes away - pagehide, freeze, and becoming hidden - each zeroize the in-memory
// profile (store.locked -> true), and each has a way back that re-reads it from IndexedDB. They are
// covered separately because they do not come in matched sets: a frozen background tab gets
// freeze/resume with no navigation, and an app-switch may deliver only visibilitychange. The last
// test covers the rule that separates the two kinds of relock - the app may undo its own hygiene,
// never the user's Lock.
//
// We dispatch the real lifecycle events rather than relying on the browser's BFCache engine, which
// is environment-dependent and cannot be forced in Playwright. Real BFCache-engine behavior is
// covered by the manual cross-browser device-smoke launch gate.

test('page-lifecycle: pagehide relocks the profile, persisted pageshow restores it', async ({
	page
}) => {
	// Seed: first-run wizard creates the encrypted profile with an EAOS.
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

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
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

	await page.goto('/settings');
	await expect(page.getByText('2027-04-15')).toBeVisible();

	await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeVisible();
	await expect(page.getByText('2027-04-15')).toBeHidden();

	await page.evaluate(() => document.dispatchEvent(new Event('resume')));
	await expect(page.getByText('2027-04-15')).toBeVisible();
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeHidden();
});

test('page-lifecycle: hiding the page relocks the profile, showing it restores', async ({
	page
}) => {
	// The only relock signal every browser fires. freeze is Chromium-only and an app-switch on iOS
	// may deliver no pagehide, so without this the plaintext of a backgrounded page stays in the
	// heap. visibilityState is read through a getter, so it is overridden rather than assigned.
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

	await page.goto('/settings');
	await expect(page.getByText('2027-04-15')).toBeVisible();

	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeVisible();
	await expect(page.getByText('2027-04-15')).toBeHidden();

	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
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
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

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
