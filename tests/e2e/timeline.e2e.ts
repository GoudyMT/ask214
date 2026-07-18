import { expect, test, type Page } from '@playwright/test';

// E2E coverage for the /timeline route shell: the Model-B render guard
// (LockedPanel when locked / SetupCTA when no EAOS / the EAOS-anchored header otherwise) plus the
// primary-nav Timeline link. Each test runs in a fresh browser context, so IndexedDB starts empty.
// The full timeline flow (mark done / collapse / notes / snooze) is covered in the E2E suite, once the list
// components exist. Lock state is driven by dispatching the real `pagehide` lifecycle event
// on window (the layout wires relock to it), mirroring bfcache.e2e.ts - the browser's own BFCache
// engine is environment-dependent and unforceable in Playwright.

const EAOS = '2027-04-15';
// Subline shows the human-formatted EAOS (formatTimelineDate: 2027-04-15 -> "Apr 15, 2027").
const SUBLINE = 'Anchored to Apr 15, 2027 - tracking your 24-month runway';

// First-run wizard saves an encrypted profile with an EAOS, then lands back on Home.
async function setEaos(page: Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(EAOS);
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeVisible();
}

test('primary nav exposes a Timeline link that routes to /timeline', async ({ page }) => {
	await page.goto('/');
	// exact: the on-ramp's "Set up your timeline" link would substring-match a loose "Timeline".
	const link = page.getByRole('link', { name: 'Timeline', exact: true });
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
	await expect(page.locator('article.task-card').first()).toBeVisible(); // generated cards render
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

test('marking a task done collapses it to a line and persists across reload', async ({ page }) => {
	await setEaos(page);
	await page.goto('/timeline');

	const firstCard = page.locator('article.task-card').first();
	await expect(firstCard).toBeVisible();
	const title = (await firstCard.locator('.task-card__title').innerText()).trim();
	await firstCard.getByRole('button', { name: 'Mark done' }).click();

	// A resolved task auto-collapses to a one-line disclosure (button.task-line.line-done).
	const doneLine = page.locator('button.task-line.line-done', { hasText: title });
	await expect(doneLine).toBeVisible();
	await expect(doneLine.getByText('Done', { exact: true })).toBeVisible();

	await page.reload();
	await expect(page.locator('button.task-line.line-done', { hasText: title })).toBeVisible(); // re-decrypted from IndexedDB
});

test('snoozing a task collapses it to a line and persists across reload', async ({ page }) => {
	await setEaos(page);
	await page.goto('/timeline');

	const firstCard = page.locator('article.task-card').first();
	const title = (await firstCard.locator('.task-card__title').innerText()).trim();
	await firstCard.getByRole('button', { name: 'Snooze' }).click();
	await firstCard.getByRole('button', { name: '1 month' }).click();

	const snoozedLine = page.locator('button.task-line.line-snoozed', { hasText: title });
	await expect(snoozedLine).toBeVisible();
	await expect(snoozedLine.getByText('Snoozed', { exact: true })).toBeVisible();

	await page.reload();
	await expect(page.locator('button.task-line.line-snoozed', { hasText: title })).toBeVisible();
});

test('a note added to a task persists across reload', async ({ page }) => {
	await setEaos(page);
	await page.goto('/timeline');

	const firstCard = page.locator('article.task-card').first();
	const note = 'Call the VSO on Monday';
	await firstCard.getByRole('button', { name: 'Add note' }).click();
	await firstCard.getByLabel('Note').fill(note);
	await firstCard.getByRole('button', { name: 'Save' }).click();
	await expect(firstCard.getByText(note)).toBeVisible(); // shows in the Notes inset

	await page.reload();
	await expect(page.locator('article.task-card').first().getByText(note)).toBeVisible(); // re-decrypted
});

test('a completed task can be expanded and restored to active', async ({ page }) => {
	await setEaos(page);
	await page.goto('/timeline');

	const firstCard = page.locator('article.task-card').first();
	const title = (await firstCard.locator('.task-card__title').innerText()).trim();
	await firstCard.getByRole('button', { name: 'Mark done' }).click();

	// Expand the collapsed line, then Restore -> the task returns to an open card with its actions.
	await page.locator('button.task-line.line-done', { hasText: title }).click();
	const resolved = page.locator('article.task-card--resolved', { hasText: title });
	await resolved.getByRole('button', { name: 'Restore' }).click();
	await expect(
		page.locator('article.task-card', { hasText: title }).getByRole('button', { name: 'Mark done' })
	).toBeVisible();
});

test('the timeline shows the phase chip-strip and the Today marker', async ({ page }) => {
	await setEaos(page);
	await page.goto('/timeline');

	await expect(page.locator('button.phase-chips__chip').first()).toBeVisible(); // jump-nav chips
	const today = page.locator('.timeline-today__pill');
	await expect(today).toBeVisible();
	await expect(today).toContainText('Today');
});

test('clicking a phase chip scrolls to its phase section', async ({ page }) => {
	await setEaos(page);
	await page.goto('/timeline');

	const chips = page.locator('button.phase-chips__chip');
	await chips.last().click(); // jump to the furthest-down phase
	await expect(page.locator('.timeline-list section').last()).toBeInViewport();
});
