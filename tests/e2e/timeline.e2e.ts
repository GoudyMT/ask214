import { expect, test, type Page } from '@playwright/test';

// E2E coverage for the /timeline route shell (Arc C, Task C2): the Model-B render guard
// (LockedPanel when locked / SetupCTA when no EAOS / the EAOS-anchored header otherwise) plus the
// primary-nav Timeline link. Each test runs in a fresh browser context, so IndexedDB starts empty.
// The full timeline flow (mark done / collapse / notes / snooze) is covered in D1, once the list
// components (C3-C5) exist. Lock state is driven by dispatching the real `pagehide` lifecycle event
// on window (the layout wires relock to it), mirroring bfcache.e2e.ts - the browser's own BFCache
// engine is environment-dependent and unforceable in Playwright.

const EAOS = '2027-04-15';
const SUBLINE = `Anchored to ${EAOS} - tracking your 24-month runway`;

// First-run wizard saves an encrypted profile with an EAOS, then lands back on Home.
async function setEaos(page: Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(EAOS);
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Transition Companion' })).toBeVisible();
}

test('primary nav exposes a Timeline link that routes to /timeline', async ({ page }) => {
	await page.goto('/');
	const link = page.getByRole('link', { name: 'Timeline' });
	await expect(link).toBeVisible();

	await link.click();
	await expect(page).toHaveURL(/\/timeline\/?$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
});

test('first-run (no EAOS): /timeline shows the setup CTA', async ({ page }) => {
	await page.goto('/timeline');
	await expect(page.getByRole('heading', { name: /set up your profile/i })).toBeVisible();
	await expect(page.getByRole('link', { name: /get started/i })).toBeVisible();
});

test('with an EAOS: /timeline shows the anchored header, not the CTA', async ({ page }) => {
	await setEaos(page);

	await page.goto('/timeline');
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
	await expect(page.getByText(SUBLINE)).toBeVisible();
	await expect(page.getByRole('link', { name: /get started/i })).toBeHidden();
});

test('locked: /timeline shows the locked panel; Unlock restores the timeline', async ({ page }) => {
	await setEaos(page);
	await page.goto('/timeline');
	await expect(page.getByText(SUBLINE)).toBeVisible();

	// pagehide (backgrounded / entering BFCache) -> relockSync: the profile locks, PII drops.
	await page.evaluate(() =>
		window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
	);
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeVisible();
	await expect(page.getByText(SUBLINE)).toBeHidden();

	// Unlock re-decrypts from IndexedDB (load()); the anchored header returns.
	await page.getByRole('button', { name: /^unlock$/i }).click();
	await expect(page.getByText(SUBLINE)).toBeVisible();
	await expect(page.getByRole('heading', { name: /your data is locked/i })).toBeHidden();
});
