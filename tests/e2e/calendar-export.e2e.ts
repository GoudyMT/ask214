import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

// The .ics export is the calendar feature's ENTIRE delivery path. This drives the real button through the real
// blob -> anchor -> click -> deferred-revoke handoff and inspects what the OS receives. It matters most on WebKit:
// the revoke was deferred specifically because WebKit and Firefox drop a file whose blob URL is freed on the click
// tick. Seeded relative to today, because the file never carries an event before today: a fixed separation date
// would make these assertions expire as the real clock passes them. The app's today is the date on the device
// clock, so the seed counts local calendar days too.
const isoFromToday = (days: number) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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

// 600 days after separation every window has closed (VGLI's last edge is 485 days after), so nothing is ahead:
// Settings says so instead of building an empty file, and the timeline does not offer the add at all.
test('a profile with nothing ahead is not offered the add', async ({ page }) => {
	await seedProfile(page, -600);
	await page.goto('/settings');
	// The sentence shows only once the calendar store has loaded, so this wait is not a race.
	await expect(page.getByText('Nothing ahead to add right now.')).toBeVisible();
	await expect(page.getByRole('button', { name: /^add to my calendar$/i })).toBeDisabled();
	await page.getByRole('link', { name: 'Timeline' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
	await expect(page.getByRole('button', { name: /^add to my calendar$/i })).toHaveCount(0);
});

// The timeline offers the add while the file would hold an event, and stops once every category is kept off,
// which empties the file just as a passed date does.
test('the timeline offers the add only while the file would hold an event', async ({ page }) => {
	await seedProfile(page, 300);
	const add = page.getByRole('button', { name: /^add to my calendar$/i });
	await expect(add).toBeVisible();
	await openSettingsAdd(page);
	await page.getByRole('button', { name: /customize what's included/i }).click();
	// One at a time, each saved before the next: the panel builds a toggle from the last saved set, so taps
	// quicker than the save can overwrite each other.
	const categories = [/^medical$/i, /^admin$/i, /^benefits$/i, /^career$/i, /^finance$/i];
	for (const [index, name] of categories.entries()) {
		await page.getByRole('checkbox', { name }).check();
		await expect(page.getByText(`${index + 1} kept off`)).toBeVisible();
	}
	await page.getByRole('link', { name: 'Timeline' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
	await expect(add).toHaveCount(0);
});

test('the add works offline', async ({ page, context }) => {
	await seedProfile(page, 600);
	const addButton = await openSettingsAdd(page);
	await context.setOffline(true);
	const { ics } = await readIcs(page, addButton);
	await context.setOffline(false);
	expect(ics).toContain('BEGIN:VEVENT');
});

/** A request as text a reader would search: the URL and the body, percent- and form-decoded. */
function decodeRequest(text: string): string {
	try {
		return decodeURIComponent(text.replace(/\+/g, ' '));
	} catch {
		return text; // a stray % that is not an escape: search the raw text instead
	}
}

// Privacy at the wire: the file is built on the device, so no request may carry anything in it. The listener is on
// the browser context, so it also sees service-worker and popup requests, and it is proven live on the page load.
// Every title and every date in the downloaded file, in both date forms, is looked for in each request after the tap.
test('no request carries a title or a date from the file', async ({ page, context }) => {
	await seedProfile(page, 600);
	const sent: string[] = [];
	context.on('request', (r) => {
		sent.push(decodeRequest(`${r.url()} ${r.postDataBuffer()?.toString('utf8') ?? ''}`));
	});
	const addButton = await openSettingsAdd(page);
	expect(sent.some((request) => request.includes('/settings'))).toBe(true);
	const fromTap = sent.length;
	const { ics } = await readIcs(page, addButton);
	await page.waitForLoadState('networkidle');
	const titles = [...ics.matchAll(/^SUMMARY:([^\r\n]*)/gm)].map((m) =>
		(m[1] ?? '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
	);
	const days = [...ics.matchAll(/^DTSTART;VALUE=DATE:(\d{8})/gm)].map((m) => m[1] ?? '');
	const dates = days.flatMap((d) => [d, `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`]);
	expect(titles.length).toBeGreaterThan(0);
	expect(dates.length).toBeGreaterThan(0);
	for (const request of sent.slice(fromTap)) {
		for (const title of titles) expect(request).not.toContain(title);
		for (const date of dates) expect(request).not.toContain(date);
	}
});
