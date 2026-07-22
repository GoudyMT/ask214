import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The .ics export is the calendar feature's ENTIRE delivery path, and it had no end-to-end coverage
// on any engine - only a unit test with a mocked click, which proves the deferred-revoke logic but
// never that a real file reaches the browser's download system. This drives the real button through
// the real blob -> anchor -> click -> deferred-revoke handoff and inspects what the OS receives.
// It matters most on WebKit: the revoke was deferred specifically because WebKit and Firefox drop a
// file whose blob URL is freed on the click tick, and WebKit had never executed this path.

async function seedProfile(page: import('@playwright/test').Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeVisible();
}

/** Trigger the real export and return the bytes the browser's download system received. */
async function readIcs(
	page: import('@playwright/test').Page,
	addButton: import('@playwright/test').Locator
): Promise<string> {
	const downloadPromise = page.waitForEvent('download');
	await addButton.click();
	const download = await downloadPromise;
	return readFileSync(await download.path(), 'utf-8');
}

test('exports a real .ics the browser actually receives', async ({ page }) => {
	await seedProfile(page);
	await page.goto('/settings');

	// The export refuses to run until the exclusion set is loaded (`ready`), so a file can never be
	// built against an unknown set. Waiting for the enabled button is waiting for that gate to open.
	const addButton = page.getByRole('button', { name: /add to apple \/ device calendar/i });
	await expect(addButton).toBeEnabled();

	const downloadPromise = page.waitForEvent('download');
	await addButton.click();
	const download = await downloadPromise;

	expect(download.suggestedFilename()).toBe('transition-deadlines.ics');

	const ics = readFileSync(await download.path(), 'utf-8');

	// A real, parseable calendar with at least one deadline. Every pending task projects to one
	// all-day VEVENT, and a bare separation-date profile still yields the universal tasks - so an
	// empty or truncated file here is a real delivery failure, not an empty timeline.
	expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
	expect(ics).toContain('END:VCALENDAR');
	expect(ics).toContain('BEGIN:VEVENT');
});

// Excluding a category must remove exactly those deadlines from the file the OS receives - the
// promise that "keep these off my calendar" is honored at the bytes, not just in the UI. Uses the
// finance category, which the universal task set always contains (the SGLI review is ungated), so
// the assertion cannot pass vacuously against a category that had no tasks to begin with.
test('a kept-off category is absent from the exported .ics', async ({ page }) => {
	await seedProfile(page);
	await page.goto('/settings');

	const addButton = page.getByRole('button', { name: /add to apple \/ device calendar/i });
	await expect(addButton).toBeEnabled();

	const baseline = await readIcs(page, addButton);
	// Non-vacuity guard: the finance task must be PRESENT before we exclude it, or "absent after"
	// proves nothing.
	expect(baseline).toContain('SGLI coverage and beneficiaries');
	const baselineCount = (baseline.match(/BEGIN:VEVENT/g) ?? []).length;

	await page.getByRole('button', { name: /customize what's included/i }).click();
	await page.getByRole('checkbox', { name: /^finance$/i }).check();
	// The persisted exclusion set is what the export reads; wait for it to register (the summary
	// flips to "1 kept off") before re-exporting, so this is not a race.
	await expect(page.getByText('1 kept off')).toBeVisible();

	const filtered = await readIcs(page, addButton);
	expect(filtered).not.toContain('SGLI coverage and beneficiaries');
	expect((filtered.match(/BEGIN:VEVENT/g) ?? []).length).toBeLessThan(baselineCount);
});
