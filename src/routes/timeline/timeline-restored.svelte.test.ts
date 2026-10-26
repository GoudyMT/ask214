import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { createTimelineStateStore } from '$lib/timeline/state.svelte';
import { createByokStore } from '$lib/ask/byok/store';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { captureBackupIntent, markBackupIntent, takeBackupIntent } from '$lib/backup/intent';
import { formatBackupDate } from '$lib/backup/dates';
import TimelinePage from './+page.svelte';

// The page runs on the real profile, timeline and API-key stores over a test database; only the app container the layout
// would hand it is replaced, so each case can set the lock and the Unlock flag. A reload cannot run in the test page, so
// it is held at the browser's own navigate event and recorded.
const harness = vi.hoisted(() => ({ app: null as ProfileApp | null }));
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => harness.app,
	setProfileApp: () => {}
}));

// A time after the backup release date, so the date line reads as a real day.
const BACKUP_AT = Date.UTC(2026, 9, 12, 12);
const KEY = 'sk-ant-api03-' + 'a'.repeat(40);
const START_URL = location.href;
// The date is the app's own formatting of the stored time, never a hand-built year (the zone decides the day).
const RESTORED = `Backup restored (made ${formatBackupDate(BACKUP_AT)}).`;
const KEPT =
	"Ask's offline library, saved documents, downloaded SkillBridge listings, this device's settings (theme, Ask mode)";
const NOT_IN_BACKUPS_NO_KEY = `Not in backups: your API key, ${KEPT}. Set them up again in Settings.`;
const NOT_IN_BACKUPS_WITH_KEY = `Not in backups: ${KEPT}. Set them up again in Settings.`;

let db: IDBDatabase | null = null;
let release: (() => void) | null = null;

/** A device holding a profile that carries a backup date, with every store the page reads loaded. */
async function device() {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	const store = createProfileStore(db);
	await store.save({
		eaos: new TextEncoder().encode('2027-04-15'),
		setupIntent: 'completed',
		lastBackupAt: BACKUP_AT
	});
	await store.load();
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	const byok = createByokStore(db);
	const app: ProfileApp = {
		status: 'ready',
		store,
		timeline,
		calendar: null,
		byok,
		cause: null,
		db,
		wipeAll: null,
		relockAll: null,
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
	};
	harness.app = app;
	return { app, store, timeline, byok };
}

/** What a restore leaves in the history entry before it reloads onto the Timeline, and the app's start-up then reads. */
function restoredHere(): void {
	markBackupIntent('restored', location.pathname + location.search);
	captureBackupIntent();
}

/** What a restore onto a device locked behind a forgotten PIN leaves before it reloads: the PIN is off afterwards. */
function restoredPinOffHere(): void {
	markBackupIntent('restored-pin-off', location.pathname + location.search);
	captureBackupIntent();
}

/** Holds every navigation the page starts, recording its kind. */
function holdNavigation(): string[] {
	const seen: string[] = [];
	const target = (window as unknown as { navigation: EventTarget }).navigation;
	const hold = (e: Event): void => {
		seen.push((e as Event & { navigationType: string }).navigationType);
		e.preventDefault();
	};
	target.addEventListener('navigate', hold);
	release = () => target.removeEventListener('navigate', hold);
	return seen;
}

/**
 * The page is up and, after the time the line needs to appear (the key store is read first), still has none. Absence
 * has to wait: a line that comes a few milliseconds after the page would pass an immediate check.
 */
async function expectNoStatusLine(): Promise<void> {
	await expect.element(page.getByText('Anchored to')).toBeVisible();
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(page.getByRole('status').elements()).toHaveLength(0);
}

beforeEach(() => {
	harness.app = null;
});

afterEach(async () => {
	release?.();
	release = null;
	takeBackupIntent('restored');
	takeBackupIntent('restored-pin-off');
	history.replaceState(history.state, '', START_URL);
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
});

describe('the Timeline right after a restore', () => {
	it('the restored line shows once, is a status region, and is gone after a reload', async () => {
		await device();
		restoredHere();
		const first = await render(TimelinePage);

		const status = page.getByRole('status');
		await expect.element(status).toHaveTextContent(`${RESTORED} ${NOT_IN_BACKUPS_NO_KEY}`);
		expect(status.elements()).toHaveLength(1);
		expect(first.container.textContent?.split(RESTORED).length).toBe(2);

		// Start-up took the note out of the entry, so a reload finds none; this second render stands for that reload,
		// and a page that had not spent the note would say this again.
		await first.unmount();
		await render(TimelinePage);
		await expectNoStatusLine();
		expect(takeBackupIntent('restored')).toBe(false);
	});

	it('shows no restored line on an ordinary visit', async () => {
		await device();
		await render(TimelinePage);
		await expectNoStatusLine();
	});

	it('the API-key item shows only when no key is stored', async () => {
		const { byok } = await device();
		await byok.saveApiKey(KEY);
		restoredHere();
		await render(TimelinePage);

		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent(`${RESTORED} ${NOT_IN_BACKUPS_WITH_KEY}`);
	});

	// A damaged keystore cannot say whether a key is there; the person is told to check rather than left to think it is.
	it('the API-key item shows when the stored key cannot be read', async () => {
		const { byok } = await device();
		vi.spyOn(byok, 'readApiKey').mockRejectedValue(new Error('E_TEST_KEYSTORE'));
		restoredHere();
		await render(TimelinePage);

		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent(`${RESTORED} ${NOT_IN_BACKUPS_NO_KEY}`);
	});
});

describe('the Timeline right after a restore onto a device locked by a forgotten PIN', () => {
	const PIN_OFF = 'Your data is back. Your PIN is off. Turn it on again in Settings.';
	const ADD_KEY = 'Add your API key again.';

	// The data came from the backup and the key store was emptied: the two lines, and none of the ordinary ones (the
	// backup's date and the list of what a backup leaves out), which would talk about a PIN that is not there.
	it('shows the two lines in a status region, in place of the ordinary restored lines, and not again after a reload', async () => {
		await device();
		restoredPinOffHere();
		const first = await render(TimelinePage);

		const status = page.getByRole('status');
		await expect.element(status).toHaveTextContent(`${PIN_OFF} ${ADD_KEY}`);
		expect(status.elements()).toHaveLength(1);
		expect(first.container.textContent).not.toContain('Backup restored');
		expect(first.container.textContent).not.toContain('Not in backups');

		await first.unmount();
		await render(TimelinePage);
		await expectNoStatusLine();
		expect(takeBackupIntent('restored-pin-off')).toBe(false);
	});

	it('says both lines whether or not an API key is stored (none can be: the restore emptied the store)', async () => {
		const { byok } = await device();
		await byok.saveApiKey(KEY);
		restoredPinOffHere();
		await render(TimelinePage);

		await expect.element(page.getByRole('status')).toHaveTextContent(`${PIN_OFF} ${ADD_KEY}`);
	});
});

describe('Timeline Unlock after a restore', () => {
	it('Unlock reloads instead of loading when a restore happened while locked', async () => {
		const { app, store, timeline } = await device();
		const profileLoad = vi.spyOn(store, 'load');
		const timelineLoad = vi.spyOn(timeline, 'load');
		await store.lock('user');
		app.reloadOnUnlock = true;
		const seen = holdNavigation();
		await render(TimelinePage);

		await page.getByRole('button', { name: 'Unlock' }).click();

		await vi.waitFor(() => expect(seen).toEqual(['reload']));
		expect(profileLoad).not.toHaveBeenCalled();
		expect(timelineLoad).not.toHaveBeenCalled();
	});
});
