import { readFileSync } from 'node:fs';
import {
	expect,
	test,
	type BrowserContext,
	type Locator,
	type Page,
	type Request
} from '@playwright/test';

// A forgotten PIN in a real browser, through the served build and its real key worker: the way back from the Unlock card
// is a restore of a saved backup (the PIN ends off) or an Erase, and a wrong set of words changes nothing. Every derive
// is real (about 1.5 s in Chromium and 2.5 s in WebKit). Every detail is made up. The service worker is blocked so every
// request comes from the page itself.
test.use({ serviceWorkers: 'block' });
test.setTimeout(180_000);

const PIN = '135790';
const WRONG_PIN = '246802';
const NEWLINE = String.fromCharCode(10);

// Copied from egress-canary.e2e.ts: the E2E files share no helper module.
const isoFromToday = (days: number) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Every form a date takes on screen or in a file: ISO, compact, and the timeline's "Mon D, YYYY". */
function dateForms(iso: string): string[] {
	const [year, month, day] = iso.split('-');
	return [iso, iso.replace(/-/g, ''), `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`];
}

/** A URL or form body read as the server would read it; unchanged when it is not validly encoded. */
function decoded(text: string): string {
	try {
		return decodeURIComponent(text.replace(/\+/g, ' '));
	} catch {
		return text;
	}
}

// What the backup holds, and what the device gains after it was made: the restore must bring back the first and nothing
// of the second.
const SEPARATION = isoFromToday(300);
const SEPARATION_ON_SCREEN = dateForms(SEPARATION)[2] ?? '';
const LATER = isoFromToday(330);
const LATER_ON_SCREEN = dateForms(LATER)[2] ?? '';
const NOTE_BEFORE = 'Canary note about Harborlight Annex made before the backup';
const NOTE_AFTER = 'Canary note about Quillmere Wharf made after the backup';

const lockedHeading = (page: Page) => page.getByRole('heading', { name: 'Your data is locked' });
const pinField = (page: Page) => page.getByLabel('PIN', { exact: true });
const appLockToggle = (page: Page) => page.getByRole('button', { name: /^app lock/i });
const unlockCard = (page: Page) => page.locator('.pin-unlock');
const restoreForm = (page: Page) => page.locator('form[aria-label="Restore from a backup"]');
const WAIT_LINE = /^That PIN is not right\. You can try again in (\d+) seconds?\.$/;
const NOT_RIGHT = 'That PIN is not right.';
const LOCKED_CONFIRM_LINE = 'This replaces everything on this device with the backup.';
const AFTER_LINES = [
	'Your data is back. Your PIN is off. Turn it on again in Settings.',
	'Add your API key again.'
];

type Backup = { name: string; text: string; words: string };

/** A browser with no save or open picker (as Firefox and Safari are): a backup is handed to the downloads. */
async function withoutPickers(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		const w = window as unknown as { showOpenFilePicker?: unknown; showSaveFilePicker?: unknown };
		delete w.showOpenFilePicker;
		delete w.showSaveFilePicker;
	});
}

/** The first-run wizard: a profile with one separation date, ending on the Timeline. */
async function setUpProfile(page: Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(SEPARATION);
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

/** A note on the first task that has none, on the Timeline page the tab is on. */
async function addNote(page: Page, note: string): Promise<void> {
	await page.getByRole('button', { name: 'Add note' }).first().click();
	await page.locator('.task-card__note-input').fill(note);
	await page
		.locator('.task-card__note-actions')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByText(note)).toBeVisible();
}

/** The six words a backup card shows, read from its text. */
async function readWords(card: Locator): Promise<string> {
	await expect(card).toContainText('Write these words down');
	const lines = (await card.innerText())
		.split(NEWLINE)
		.map((s) => s.trim())
		.filter(Boolean);
	const at = lines.findIndex((s) => s.startsWith('Write these words down'));
	const words = lines.slice(at + 1, at + 7).join(' ');
	expect(words.split(' ')).toHaveLength(6);
	return words;
}

/** Settings -> Make a backup -> the six words typed back -> the browser's download. Returns the file and its words. */
async function makeBackup(page: Page): Promise<Backup> {
	await page.goto('/settings');
	await page.locator('#backup-toggle-export').click();
	await page.getByRole('button', { name: 'Show my passphrase' }).click();
	const words = await readWords(page.locator('.backup-card'));
	const form = page.locator('form[aria-label="Make a backup"]');
	await form.locator('input[type=password]').fill(words);
	const downloading = page.waitForEvent('download');
	await form.getByRole('button', { name: 'Make a backup' }).click();
	const download = await downloading;
	const name = download.suggestedFilename();
	await expect(page.locator('.backup-result')).toContainText('Backup downloaded as ' + name, {
		timeout: 60_000
	});
	const text = readFileSync(await download.path(), 'utf-8');
	expect(() => JSON.parse(text)).not.toThrow();
	return { name, text, words };
}

/** Settings -> App lock -> the PIN twice -> Next -> the backup step, skipped, to the "PIN on" row. */
async function turnOnPin(page: Page): Promise<void> {
	await page.goto('/settings');
	await appLockToggle(page).click();
	await page.getByLabel('Choose a 4-6 digit PIN').fill(PIN);
	await page.getByLabel('Enter it again').fill(PIN);
	await page.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(page.getByText('One more step: make a backup')).toBeVisible({ timeout: 30_000 });
	await page.getByRole('button', { name: 'Skip and turn on', exact: true }).click();
	await expect(appLockToggle(page)).toContainText('PIN on', { timeout: 30_000 });
}

async function pressUnlock(page: Page, pin: string): Promise<void> {
	await pinField(page).fill(pin);
	await page.getByRole('button', { name: 'Unlock', exact: true }).click();
}

type Tries = { count: number; waitMs: number; pending: boolean } | null;

/** The wrong-try row of the app-lock store, read straight from IndexedDB. Null when no try was ever counted. */
async function readTriesRow(page: Page): Promise<Tries> {
	return page.evaluate(
		() =>
			new Promise<Tries>((resolve, reject) => {
				const open = indexedDB.open('mtc');
				open.onerror = () => reject(new Error('E_TEST_OPEN'));
				open.onsuccess = () => {
					const db = open.result;
					const get = db.transaction('app-lock', 'readonly').objectStore('app-lock').get('tries');
					get.onerror = () => reject(new Error('E_TEST_READ'));
					get.onsuccess = () => {
						db.close();
						const row = get.result as
							{ count: number; waitMs: number; pending: boolean } | undefined;
						resolve(row ? { count: row.count, waitMs: row.waitMs, pending: row.pending } : null);
					};
				};
			})
	);
}

/** The key record's lock mode and install id, read straight from IndexedDB. */
async function readKeystoreIdentity(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const open = indexedDB.open('mtc');
				open.onerror = () => reject(new Error('E_TEST_OPEN'));
				open.onsuccess = () => {
					const db = open.result;
					const get = db.transaction('keystore', 'readonly').objectStore('keystore').get(0);
					get.onerror = () => reject(new Error('E_TEST_READ'));
					get.onsuccess = () => {
						db.close();
						const row = get.result as { mode?: string; installUuid?: Uint8Array } | undefined;
						resolve(`${String(row?.mode)}:${Array.from(row?.installUuid ?? []).join(',')}`);
					};
				};
			})
	);
}

/**
 * A device a person has forgotten the PIN of: a backup made with the PIN off from a profile with a date and a note, then
 * a later date and a later note, then the PIN on, and a fresh load onto the Unlock card.
 */
async function lockedDeviceWithBackup(page: Page, context: BrowserContext): Promise<Backup> {
	await withoutPickers(context);
	await setUpProfile(page);
	await addNote(page, NOTE_BEFORE);
	const backup = await makeBackup(page);

	// What the device gains after the backup.
	await page.getByRole('button', { name: /separation date/i }).click();
	await page.getByLabel(/separation date/i).fill(LATER);
	await page
		.getByLabel('Transition timeline')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByText(LATER_ON_SCREEN)).toBeVisible();
	await page.goto('/timeline');
	await addNote(page, NOTE_AFTER);

	await turnOnPin(page);
	await page.goto('/timeline');
	await expect(lockedHeading(page)).toBeVisible();
	await expect(page.getByText(/Anchored to/)).toHaveCount(0);
	return backup;
}

/** The Unlock card -> Forgot PIN? -> Restore from a backup -> the file chosen and the words typed, up to the confirm. */
async function chooseBackupOnForgotScreen(
	page: Page,
	backup: Backup,
	words: string
): Promise<void> {
	await page.getByRole('button', { name: 'Forgot PIN?' }).click();
	await expect(page.getByRole('heading', { name: 'Forgot your PIN?' })).toBeVisible();
	await page.getByRole('button', { name: 'Restore from a backup', exact: true }).click();
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Choose file' }).click();
	await (
		await chooser
	).setFiles({
		name: backup.name,
		mimeType: 'application/json',
		buffer: Buffer.from(backup.text)
	});
	await restoreForm(page).locator('input[type=password]').fill(words);
	await restoreForm(page).getByRole('button', { name: 'Restore', exact: true }).click();
}

// 7. The use: the PIN is forgotten and a saved backup is the way back. The device ends with the backup's data, nothing
// the device gained afterwards, and no PIN.
test('Forgot PIN: restoring a backup brings back its data, turns the PIN off, and says so', async ({
	page,
	context
}) => {
	const backup = await lockedDeviceWithBackup(page, context);
	await chooseBackupOnForgotScreen(page, backup, backup.words);

	// The file opened first, offline, with the six words; only then is the person asked.
	const confirm = page.locator('dialog[open]');
	await expect(confirm).toBeVisible({ timeout: 30_000 });
	await expect(confirm).toContainText(LOCKED_CONFIRM_LINE);
	// A device locked behind a forgotten PIN cannot keep its API key, so the list does not say it is kept.
	await expect(confirm).not.toContainText('API key');
	await expect(confirm).toContainText('saved documents');
	await confirm.getByRole('button', { name: 'Replace' }).click();

	// The Timeline shows the backup's data and only the two lines the table gives.
	await expect(page.locator('.timeline-restored p')).toHaveText(AFTER_LINES, { timeout: 60_000 });
	await expect(page.getByText(/^Backup restored \(made /)).toHaveCount(0);
	await expect(page.getByText(/^Not in backups: /)).toHaveCount(0);
	await expect(page.getByText(`Anchored to ${SEPARATION_ON_SCREEN}`)).toBeVisible();
	await expect(page.getByText(NOTE_BEFORE)).toBeVisible();
	await expect(page.getByText(NOTE_AFTER)).toHaveCount(0);
	await expect(page.getByText(`Anchored to ${LATER_ON_SCREEN}`)).toHaveCount(0);
	await expect(lockedHeading(page)).toHaveCount(0);

	// The PIN is off: the next open asks for nothing and the row says Off.
	await page.reload();
	await expect(page.getByText(`Anchored to ${SEPARATION_ON_SCREEN}`)).toBeVisible();
	await expect(lockedHeading(page)).toHaveCount(0);
	await expect(pinField(page)).toHaveCount(0);
	await page.goto('/settings');
	await expect(appLockToggle(page)).toContainText('Off');
	expect((await readKeystoreIdentity(page)).startsWith('local:')).toBe(true);
});

// 8. The use: the wrong words must not cost the person their data.
test('Forgot PIN: the right file with the wrong words changes nothing, and the old PIN still opens it all', async ({
	page,
	context
}) => {
	const backup = await lockedDeviceWithBackup(page, context);
	const before = await readKeystoreIdentity(page);
	const triesBefore = await readTriesRow(page);
	expect(before.startsWith('pin:')).toBe(true);

	const wrongWords = backup.words.split(' ').reverse().join(' ');
	expect(wrongWords).not.toBe(backup.words);
	await chooseBackupOnForgotScreen(page, backup, wrongWords);
	await expect(unlockCard(page).getByRole('alert')).toContainText(
		'These words do not open this backup.',
		{ timeout: 30_000 }
	);
	await expect(unlockCard(page).getByRole('alert')).toContainText(
		'Nothing on this device was changed.'
	);
	await expect(page.locator('dialog[open]')).toHaveCount(0);

	// Nothing on the device moved: the same PIN key record and the same wrong-try row.
	expect(await readKeystoreIdentity(page)).toBe(before);
	expect(await readTriesRow(page)).toEqual(triesBefore);

	await page.getByRole('button', { name: 'Back to Unlock' }).click();
	await expect(lockedHeading(page)).toBeVisible();
	await pressUnlock(page, PIN);
	await expect(page.getByText(`Anchored to ${LATER_ON_SCREEN}`)).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(NOTE_BEFORE)).toBeVisible();
	await expect(page.getByText(NOTE_AFTER)).toBeVisible();
	await expect(page.locator('.timeline-restored')).toHaveCount(0);
});

// 9. The use: the PIN and the backup are both gone, and the person starts the app over.
test('Forgot PIN: Erase and start over wipes the device and the app starts again with no PIN', async ({
	page,
	context
}) => {
	await lockedDeviceWithBackup(page, context);

	await page.getByRole('button', { name: 'Forgot PIN?' }).click();
	await page.getByRole('button', { name: 'Erase and start over' }).click();

	// The Erase is the app's own, in Settings, opened on arrival.
	await expect(page).toHaveURL(/\/settings$/);
	const erase = page.getByRole('button', { name: /^erase everything$/i });
	await expect(erase).toBeVisible();
	const reloaded = page.waitForEvent('load');
	await erase.click();
	await reloaded;

	await page.goto('/');
	await expect(page.getByRole('link', { name: /set up your timeline/i })).toBeVisible({
		timeout: 15_000
	});
	await expect(lockedHeading(page)).toHaveCount(0);
	await page.goto('/timeline');
	await expect(page.getByText(/Anchored to/)).toHaveCount(0);
	await expect(lockedHeading(page)).toHaveCount(0);
	// The key record is a fresh one in local mode, and the wrong tries went with the rest.
	expect((await readKeystoreIdentity(page)).startsWith('local:')).toBe(true);
	expect(await readTriesRow(page)).toBeNull();
});

// 10. The use: a reload is not a way round the wait. The wait that was left when the page went is the wait that is left
// when it comes back, not a fresh one.
test('a reload in the middle of a wait resumes what was left of it', async ({ page }) => {
	// Installed before the page loads, so the app's performance.now and Date.now both move with the test's clock.
	await page.clock.install();
	await setUpProfile(page);
	await turnOnPin(page);
	await page.goto('/timeline');
	await expect(lockedHeading(page)).toBeVisible();

	for (const tries of [1, 2, 3]) {
		await pressUnlock(page, WRONG_PIN);
		await expect
			.poll(() => readTriesRow(page), { timeout: 30_000 })
			.toMatchObject({ count: tries, pending: false });
		await expect(unlockCard(page).getByRole('alert')).toHaveText(NOT_RIGHT);
	}
	// The 4th wrong try owes the first wait, 30 seconds.
	await pressUnlock(page, WRONG_PIN);
	await expect(unlockCard(page).getByRole('alert')).toHaveText(
		'That PIN is not right. You can try again in 30 seconds.',
		{ timeout: 30_000 }
	);

	// Twenty seconds pass and the page notes what is left of the wait.
	await page.clock.fastForward('00:20');
	await expect
		.poll(async () => {
			const waitMs = (await readTriesRow(page))?.waitMs ?? -1;
			return waitMs > 0 && waitMs <= 11_000;
		})
		.toBe(true);

	await page.reload();
	await expect(lockedHeading(page)).toBeVisible();
	await pressUnlock(page, PIN);
	const alert = unlockCard(page).getByRole('alert');
	await expect(alert).toHaveText(WAIT_LINE);
	// What is left, not thirty seconds again, and the right PIN was not even tried.
	const seconds = Number(WAIT_LINE.exec((await alert.textContent()) ?? '')?.[1]);
	expect(seconds).toBeGreaterThan(0);
	expect(seconds).toBeLessThanOrEqual(11);
	await expect(lockedHeading(page)).toBeVisible();
	expect(await readTriesRow(page)).toMatchObject({ count: 4, pending: false });

	// Past the rest of it the right PIN opens.
	await page.clock.fastForward('00:11');
	await expect(unlockCard(page).getByRole('alert')).toHaveCount(0);
	await pressUnlock(page, PIN);
	await expect(page.getByText(`Anchored to ${SEPARATION_ON_SCREEN}`)).toBeVisible({
		timeout: 30_000
	});
	await expect(lockedHeading(page)).toHaveCount(0);
});

// 11. The use: the way back from a forgotten PIN sends nothing off the phone. Every request from the first set-up to the
// restored Timeline is read for the saved details, the PIN and the six words, in each form they take on the wire.
const CONTROL_PATH = '/api/e2e-control';
const CONTROL_MARKER = 'egress-control-marker-0043';

/** Refuses every /api/ request and lists the ones that got that far, then proves the refusal with one of its own. */
async function sealApi(context: BrowserContext, page: Page): Promise<string[]> {
	const reached: string[] = [];
	await context.route('**/api/**', (route) => {
		reached.push(new URL(route.request().url()).pathname);
		return route.abort();
	});
	await page.goto('/');
	const outcome = await page.evaluate(
		({ path, marker }) =>
			fetch(path, { method: 'POST', body: marker }).then(
				() => 'reached the network',
				() => 'refused'
			),
		{ path: CONTROL_PATH, marker: CONTROL_MARKER }
	);
	expect(outcome).toBe('refused');
	expect(reached).toEqual([CONTROL_PATH]);
	return reached;
}

test('Forgot PIN: nothing saved, no PIN and no six words leave the page on the way back', async ({
	page,
	context
}) => {
	const requests: Request[] = [];
	context.on('request', (request) => requests.push(request));
	const reached = await sealApi(context, page);

	const backup = await lockedDeviceWithBackup(page, context);
	await chooseBackupOnForgotScreen(page, backup, backup.words);
	const confirm = page.locator('dialog[open]');
	await expect(confirm).toBeVisible({ timeout: 30_000 });
	await confirm.getByRole('button', { name: 'Replace' }).click();
	await expect(page.locator('.timeline-restored p')).toHaveText(AFTER_LINES, { timeout: 60_000 });
	await expect(page.getByText(`Anchored to ${SEPARATION_ON_SCREEN}`)).toBeVisible();

	const sent = await Promise.all(
		requests.map(async (request) => ({
			url: request.url(),
			body: request.postData() ?? '',
			headers: JSON.stringify(await request.allHeaders())
		}))
	);
	const readable = (r: { url: string; body: string; headers: string }) =>
		[r.url, decoded(r.url), r.body, decoded(r.body), r.headers].join(NEWLINE);

	// The control for the scan itself: it sees a body, so an absent value is absent and not unread.
	expect(
		sent.some((r) => readable(r).includes(CONTROL_MARKER)),
		'the scan reads the control request'
	).toBe(true);
	// And the seal held: the only /api/ request in the whole run is the control.
	expect(reached).toEqual([CONTROL_PATH]);

	const words = backup.words.split(' ');
	const personal = [
		...dateForms(SEPARATION),
		...dateForms(LATER),
		NOTE_BEFORE,
		NOTE_AFTER,
		PIN,
		words.join(' '),
		words.join('-'),
		words.join('')
	];
	for (const request of sent) {
		const text = readable(request);
		for (const value of personal) {
			expect(text, `${value} in ${request.url}`).not.toContain(value);
		}
	}
});
