import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';
import {
	damageProfileMark,
	feedFile,
	makeBackup,
	restoreOpenRow,
	sealApi,
	setUpTimeline,
	startBackup,
	useInMemoryFiles,
	CONTROL_PATH
} from './helpers/backup';

// The backup flows the built app shows end to end, on both engines: a file that left the first device by the browser's
// download, a second tab that follows a restore, and the setup screen after a damaged device's Erase. Each restore runs
// the real key derivation (about 1.5 s in Chromium), so the rows that restore are marked slow.

// A browser with no save or open picker, as Firefox and Safari are: the backup is handed to the downloads and the
// restore reads a file the person chooses.
async function withoutPickers(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		const w = window as unknown as { showOpenFilePicker?: unknown; showSaveFilePicker?: unknown };
		delete w.showOpenFilePicker;
		delete w.showSaveFilePicker;
	});
}

test('a backup saved by download opens on another device', async ({ page, context, browser }) => {
	test.slow();
	await withoutPickers(context);
	const first = await sealApi(context, page);
	expect(await page.evaluate(() => 'showSaveFilePicker' in window)).toBe(false);
	await setUpTimeline(page);
	await page.goto('/settings');

	const words = await startBackup(page);
	const downloading = page.waitForEvent('download');
	await page
		.locator('form[aria-label="Make a backup"]')
		.getByRole('button', { name: 'Make a backup' })
		.click();
	const download = await downloading;
	const backup = {
		name: download.suggestedFilename(),
		text: readFileSync(await download.path(), 'utf-8'),
		words
	};
	await expect(page.locator('.backup-result')).toContainText('Backup downloaded as ' + backup.name);
	// Whole, as the card made it: the browser's file is the one the person will carry to the other device.
	expect(() => JSON.parse(backup.text)).not.toThrow();

	// The file the browser kept is the file that opens, with the words that were shown.
	await page.getByRole('button', { name: 'Check a backup' }).click();
	await feedFile(page, backup);
	const check = page.locator('form[aria-label="Check a backup"]');
	await check.locator('input[type=password]').fill(words);
	await check.getByRole('button', { name: 'Check', exact: true }).click();
	await expect(page.locator('.backup-result')).toContainText('This backup opens. Made on', {
		timeout: 30_000
	});

	// A second browser profile: its own storage, its own key, and nothing of the first device but the file and the words.
	const other = await browser.newContext();
	try {
		await withoutPickers(other);
		const otherPage = await other.newPage();
		const second = await sealApi(other, otherPage);
		await otherPage.goto('/wizard');
		await expect(
			otherPage.getByRole('heading', { level: 1, name: 'Set up your profile' })
		).toBeVisible();
		await otherPage
			.getByRole('button', { name: 'Moving to a new phone? Restore from a backup' })
			.click();
		await restoreOpenRow(otherPage, backup);
		expect(second.reached).toEqual([CONTROL_PATH]);
	} finally {
		await other.close();
	}
	expect(first.reached).toEqual([CONTROL_PATH]);
});

// What makes a page "hidden" to the app: its flag and its state, then the event a browser fires. Driven by hand because
// two pages of one test browser are both shown, as bfcache.e2e.ts does for the same event.
const SHOWN = { hidden: false, state: 'visible' } as const;
const HIDDEN = { hidden: true, state: 'hidden' } as const;

test('a peer tab reloads once when it is shown', async ({ context }) => {
	test.slow();
	await useInMemoryFiles(context);
	const tabA = await context.newPage();
	await sealApi(context, tabA);
	await setUpTimeline(tabA);
	await tabA.goto('/settings');
	const backup = await makeBackup(tabA);

	// Tab A's date moves on after the backup, so the restore has something to put back and the peer something to show.
	await tabA.getByRole('button', { name: /separation date/i }).click();
	await tabA.getByLabel(/separation date/i).fill('2028-08-20');
	await tabA
		.getByLabel('Transition timeline')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(tabA.getByText('Aug 20, 2028')).toBeVisible();

	const tabB = await context.newPage();
	await tabB.goto('/timeline');
	await expect(tabB.getByText(/^Anchored to Aug 20, 2028/)).toBeVisible();
	let loads = 0;
	tabB.on('load', () => loads++);
	const setVisibility = (to: typeof SHOWN | typeof HIDDEN) =>
		tabB.evaluate((v) => {
			Object.defineProperty(document, 'hidden', { value: v.hidden, configurable: true });
			Object.defineProperty(document, 'visibilityState', { value: v.state, configurable: true });
			document.dispatchEvent(new Event('visibilitychange'));
		}, to);
	// Counts what reaches tab B, so the test knows the restore's signal has been delivered before it looks at the page.
	// `kept` is gone with the document: a reload would take it with it.
	await tabB.evaluate(() => {
		const w = window as unknown as { kept: boolean; signals: number };
		w.kept = true;
		w.signals = 0;
		const channel = new BroadcastChannel('mtc-profile');
		channel.onmessage = (e: MessageEvent) => {
			if ((e.data as { type?: string } | null)?.type === 'data-replaced') w.signals++;
		};
	});
	await setVisibility(HIDDEN);
	await expect(tabB.getByRole('heading', { name: /your data is locked/i })).toBeVisible();

	await tabA.getByRole('button', { name: 'Restore from a backup' }).click();
	await restoreOpenRow(tabA, backup);

	await expect
		.poll(() =>
			tabB.evaluate(() => (window as unknown as { signals: number }).signals).catch(() => -1)
		)
		.toBe(1);
	// Hidden, it has not reloaded and holds no plaintext.
	expect(await tabB.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
	expect(loads).toBe(0);
	await expect(tabB.getByText(/^Anchored to /)).toHaveCount(0);

	// Shown, it reloads. The restored date can appear without a reload (the lifecycle re-reads the saved profile when a
	// page is shown), so the reload itself is what is counted, and then the page is let settle.
	await setVisibility(SHOWN);
	await expect.poll(() => loads).toBe(1);
	await expect(tabB.getByText(/^Anchored to Apr 15, 2027/)).toBeVisible();
	await tabB.waitForLoadState('load');
	expect(loads).toBe(1);
});

test('Back from About re-renders the setup screen after the restore note', async ({
	page,
	context
}) => {
	const { reached } = await sealApi(context, page);
	await setUpTimeline(page);
	await damageProfileMark(page);
	await page.reload();
	await expect(page.getByRole('alert')).toContainText("can't be read");
	await page.getByRole('alert').getByRole('link', { name: 'Settings' }).click();
	await page.getByRole('button', { name: /erase all data on this device/i }).click();
	await page.getByRole('button', { name: /^erase everything$/i }).click();

	// The Erase reloads onto the setup screen with the restore row open.
	await expect(page).toHaveURL(/\/wizard$/, { timeout: 15_000 });
	await expect(page.getByRole('button', { name: 'Choose file' })).toBeVisible({ timeout: 15_000 });

	await page.getByRole('link', { name: 'About', exact: true }).click();
	await expect(page).toHaveURL(/\/about\/?$/);
	await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible();
	await page.goBack();

	// The note was taken once, at the start, so the row is closed now; the screen itself has to be there.
	await expect(page).toHaveURL(/\/wizard$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Set up your profile' })).toBeVisible();
	await expect(page.getByLabel(/separation date/i)).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Moving to a new phone? Restore from a backup' })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Choose file' })).toHaveCount(0);
	expect(reached).toEqual([CONTROL_PATH]);
});
