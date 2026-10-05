import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

// Copied from calendar-export.e2e.ts: the E2E files share no helper module. Seeded relative to today, because the
// file never carries an event before today, and the app's today is the device clock's local date.
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
	// The add waits for the exclusion set to load, so an enabled button means the gate is open.
	await expect(addButton).toBeEnabled();
	return addButton;
}

function decodeRequest(text: string): string {
	try {
		return decodeURIComponent(text.replace(/\+/g, ' '));
	} catch {
		return text; // a stray % that is not an escape: search the raw text instead
	}
}

const SEP_IN = 208; // separation in 208 days
const SB_IN = 28; // SkillBridge starts in 28 days, so the last day at the command is in 27
const compact = (iso: string) => iso.replace(/-/g, '');

/** Open the SkillBridge row in Settings, type a date and press Save; the caller waits for the outcome. */
async function enterSkillBridge(page: Page, iso: string): Promise<void> {
	await page.goto('/settings');
	await page.getByRole('button', { name: /skillbridge start/i }).click();
	await page.getByLabel('SkillBridge start').fill(iso);
	await page
		.getByLabel('Transition timeline')
		.getByRole('button', { name: /^save$/i })
		.click();
}

/** The lines of the one event whose title is exactly `title`; fails unless exactly one event has it. */
function eventTitled(ics: string, title: string): string[] {
	const events = ics
		.split('BEGIN:VEVENT')
		.slice(1)
		.map((event) => event.split('\r\n'))
		.filter((lines) => lines.includes(`SUMMARY:${title}`));
	expect(events).toHaveLength(1);
	return events[0] ?? [];
}

// The error catcher is installed by SvelteKit's start-up hook, before any page code runs, and nothing else in the
// app cancels a window error. So a synthetic error that comes back cancelled proves the catcher is live.
test('an error that reaches the window is stopped before the browser reports it', async ({
	page
}) => {
	await page.goto('/');
	await expect
		.poll(() =>
			page.evaluate(() => {
				const ev = new ErrorEvent('error', { message: 'x', cancelable: true });
				window.dispatchEvent(ev);
				return ev.defaultPrevented;
			})
		)
		.toBe(true);
});

// The path a user takes: a SkillBridge date typed in Settings moves TAP's last day to the day before it, on the
// Timeline and in the calendar file, and a task that cannot fit becomes a "Before you leave" event on that day.
// The listener is on the browser context, so it also sees service-worker requests, and it is proven live on the
// Settings load; no request may carry the typed date, the moved day or the new title.
test('a SkillBridge date pulls TAP in and reaches the calendar file, with nothing sent anywhere', async ({
	page,
	context
}) => {
	await seedProfile(page, SEP_IN);
	const sent: string[] = [];
	context.on('request', (r) => {
		sent.push(decodeRequest(`${r.url()} ${r.postDataBuffer()?.toString('utf8') ?? ''}`));
	});

	await enterSkillBridge(page, isoFromToday(SB_IN));
	expect(sent.some((request) => request.includes('/settings'))).toBe(true);
	await expect(page.getByLabel('SkillBridge start')).toBeHidden(); // the row closes once the date is saved
	await page.goto('/timeline');
	await expect(page.getByText(/^SkillBridge from /)).toBeVisible();
	await expect(page.locator('#task-tap-capstone')).toContainText(', before SkillBridge');

	const { ics } = await readIcs(page, await openSettingsAdd(page));
	await page.waitForLoadState('networkidle');
	const lastDay = compact(isoFromToday(SB_IN - 1));
	expect(eventTitled(ics, 'Last day: Complete your TAP Capstone')).toContain(
		`DTSTART;VALUE=DATE:${lastDay}`
	);
	expect(
		eventTitled(ics, 'Before you leave: Gather reference and recommendation letters')
	).toContain(`DTSTART;VALUE=DATE:${lastDay}`);

	const typed = isoFromToday(SB_IN);
	const moved = isoFromToday(SB_IN - 1);
	for (const request of sent) {
		for (const date of [typed, compact(typed), moved, compact(moved)]) {
			expect(request).not.toContain(date);
		}
		expect(request).not.toContain('Before you leave');
	}
});

// Both refusals keep the date out of the profile: the Timeline still invites the dates instead of naming one.
test('a date outside the input range or on separation is refused, and nothing is saved', async ({
	page
}) => {
	await seedProfile(page, SEP_IN);
	await enterSkillBridge(page, isoFromToday(-6 * 365)); // a year typo: more than the five years back allowed
	await expect(page.getByText('Enter a date within about 15 years from today.')).toBeVisible();
	await page.getByLabel('SkillBridge start').fill(isoFromToday(SEP_IN));
	await page
		.getByLabel('Transition timeline')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByText('This date needs to be before your separation date.')).toBeVisible();
	await page.goto('/timeline');
	await expect(page.getByText('Doing SkillBridge or taking terminal leave?')).toBeVisible();
});
