import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

// The .ics export is the calendar feature's ENTIRE delivery path. This drives the real button through the real
// blob -> anchor -> click -> deferred-revoke handoff and inspects what the OS receives. It matters most on WebKit:
// the revoke was deferred specifically because WebKit and Firefox drop a file whose blob URL is freed on the click
// tick. Seeded relative to today, because the file never carries an event before today: a fixed separation date
// would make these assertions expire as the real clock passes them.
const DAY = 86_400_000;
const isoFromToday = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

async function seedProfile(page: Page, separationInDays: number): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(isoFromToday(separationInDays));
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

/** Click the add and return the file the browser received, with folded lines joined back. */
async function readIcs(page: Page, addButton: Locator): Promise<{ name: string; ics: string }> {
	const downloadPromise = page.waitForEvent('download');
	await addButton.click();
	const download = await downloadPromise;
	const ics = readFileSync(await download.path(), 'utf-8').replace(/\r\n /g, '');
	return { name: download.suggestedFilename(), ics };
}

async function openSettingsAdd(page: Page): Promise<Locator> {
	await page.goto('/settings');
	const addButton = page.getByRole('button', { name: /^add to my calendar$/i });
	// The export refuses to run until the exclusion set is loaded, so a file can never be built against an
	// unknown set. Waiting for the enabled button is waiting for that gate to open.
	await expect(addButton).toBeEnabled();
	return addButton;
}

test('exports a dated calendar file with no past events and alerts before firm days', async ({
	page
}) => {
	// 300 days out: preseparation counseling's window and several aim dates have passed (so "no past events" has
	// something to drop), while the BDD claim's last day is still 210 days ahead.
	await seedProfile(page, 300);
	const { name, ics } = await readIcs(page, await openSettingsAdd(page));
	expect(name).toBe(`ask214-deadlines-${isoFromToday(0)}.ics`);
	expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
	expect(ics).toContain('END:VCALENDAR');
	expect(ics).toContain('SUMMARY:Last day: File your VA disability claim through BDD');
	expect(ics).toContain('BEGIN:VALARM');
	const today = isoFromToday(0).replace(/-/g, '');
	const starts = [...ics.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].map((m) => m[1] ?? '');
	expect(starts.length).toBeGreaterThan(0);
	for (const start of starts) expect(start >= today).toBe(true);
});

// Excluding a category must remove exactly those deadlines from the file the OS receives - the promise that
// "keep these off my calendar" is honored at the bytes, not just in the UI.
test('a kept-off category is absent from the exported file', async ({ page }) => {
	await seedProfile(page, 600);
	const addButton = await openSettingsAdd(page);
	// Non-vacuity: the finance task (SGLI, aimed 60 days out with this seed) is there before it is excluded.
	const baseline = (await readIcs(page, addButton)).ics;
	expect(baseline).toContain('SGLI coverage and beneficiaries');
	const baselineCount = (baseline.match(/BEGIN:VEVENT/g) ?? []).length;
	await page.getByRole('button', { name: /customize what's included/i }).click();
	await page.getByRole('checkbox', { name: /^finance$/i }).check();
	// The persisted exclusion set is what the export reads; wait for it to register before re-exporting.
	await expect(page.getByText('1 kept off')).toBeVisible();
	const filtered = (await readIcs(page, addButton)).ics;
	expect(filtered).not.toContain('SGLI coverage and beneficiaries');
	expect((filtered.match(/BEGIN:VEVENT/g) ?? []).length).toBeLessThan(baselineCount);
});

test('the add works offline and no request carries a title or a date', async ({
	page,
	context
}) => {
	await seedProfile(page, 600);
	const addButton = await openSettingsAdd(page);
	const sent: string[] = [];
	page.on('request', (r) => sent.push(`${r.url()} ${r.postData() ?? ''}`));
	await context.setOffline(true);
	const { ics } = await readIcs(page, addButton);
	await context.setOffline(false);
	expect(ics).toContain('BEGIN:VEVENT');
	for (const line of sent) {
		expect(line).not.toMatch(/SGLI coverage|VA disability claim|BEGIN:VCALENDAR/);
		expect(line).not.toContain(isoFromToday(600));
	}
});
