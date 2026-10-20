import { render } from 'vitest-browser-svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { resolve } from '$app/paths';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { withStores } from '$lib/db/schema';
import { wipeAllStores } from '$lib/db/wipe';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import {
	createJoinRelock,
	relockAll,
	relockEachSync,
	type Relockable
} from '$lib/profile/app-init';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore, type ProfileStore } from '$lib/profile/store.svelte';
import {
	CARD_INTRO_LINE,
	CARD_LABELS,
	ERASE_DEVICE_BUTTON,
	LOCKED_AFTER_RESTORE_LINE,
	NO_BACKUP_YET_LINE,
	NOT_IN_BACKUPS_LEAD,
	PHRASE_NOTE,
	RESTORED_UNLOCK_LINE,
	savedLine
} from '$lib/backup/copy';
import type { SaveHandle } from '$lib/backup/export-flow';
import goldenText from '$lib/backup/golden/v1-1.ask214backup?raw';
import { GOLDEN_PASSWORD } from '$lib/backup/golden/golden';
import { captureBackupIntent, takeBackupIntent } from '$lib/backup/intent';
import { backupSession, type OpenPicker, type WorkerLike } from '$lib/backup/session.svelte';
import { createHandler } from '$lib/backup/worker/handler';
import type { WorkerRequest } from '$lib/backup/worker/protocol';
import { WORDS_V1 } from '$lib/backup/words-v1';
import SettingsPage from './+page.svelte';

// The page runs on a real device: a test database with the real profile store, the real relock walk, the tab's real
// backup session and flows and the real card. Only what a person cannot touch is faked: the app container the layout
// would set, the slow key step (the pinned output, as the golden test does), the system file chooser, and the reload.
const harness = vi.hoisted(() => ({ app: null as ProfileApp | null }));
// The write itself, held after it has committed: the one moment a person can press Lock "during the write".
const writer = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock('$lib/backup/restore-writer', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/backup/restore-writer')>();
	return {
		...real,
		restoreBackup: async (...args: Parameters<typeof real.restoreBackup>) => {
			const result = await real.restoreBackup(...args);
			await writer.hold;
			return result;
		}
	};
});

vi.mock('$lib/profile/context', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/profile/context')>();
	return { ...real, getProfileApp: () => harness.app, setProfileApp: () => {} };
});
vi.mock('$lib/install/context', () => ({
	getInstallApp: () => ({
		canPrompt: false,
		installed: true,
		ios: false,
		persisted: true,
		promptInstall: async () => 'dismissed'
	}),
	setInstallApp: () => {}
}));
// No service worker controls the test page, and the wait for one is ten seconds.
vi.mock('$lib/ask/when-controlled', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/ask/when-controlled')>();
	return { ...real, waitForControl: () => Promise.resolve(true) };
});
// A backup made here has words of its own, which the pinned output cannot answer: while this is set, the key step is a
// cheap function of the password and the salt, so the same words open the file and others do not.
const kdf = vi.hoisted(() => ({ standIn: false }));
// The slow key step answers with the pinned output for exactly the pinned password, salt and settings.
vi.mock('@noble/hashes/argon2.js', async () => {
	const golden = await import('$lib/backup/golden/golden');
	const same = (a: Uint8Array, b: Uint8Array) =>
		a.length === b.length && a.every((x, i) => x === b[i]);
	return {
		argon2id: (pass: Uint8Array, salt: Uint8Array, opts: Record<string, unknown>) => {
			if (kdf.standIn) {
				return Uint8Array.from(
					{ length: 32 },
					(_, i) => (pass[i % pass.length] ?? 0) ^ (salt[i % salt.length] ?? 0) ^ i
				);
			}
			const asked =
				same(pass, new TextEncoder().encode(golden.GOLDEN_PASSWORD)) &&
				same(salt, golden.GOLDEN_SALT) &&
				opts.t === 4 &&
				opts.m === 131072 &&
				opts.p === 2 &&
				opts.version === 0x13 &&
				opts.dkLen === 32;
			if (!asked) throw new Error('E_TEST_ARGON_INPUT');
			return Uint8Array.from({ length: 32 }, (_, i) =>
				parseInt(golden.GOLDEN_ARGON2_HEX.slice(2 * i, 2 * i + 2), 16)
			);
		}
	};
});

class HandlerWorker implements WorkerLike {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessageerror: ((event: unknown) => void) | null = null;
	#dead = false;

	postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
		const arrived = structuredClone(message, { transfer }) as WorkerRequest;
		const { handle } = createHandler(WORDS_V1, (data) => {
			setTimeout(() => {
				if (!this.#dead) this.onmessage?.({ data });
			}, 0);
		});
		void handle(arrived);
	}

	terminate(): void {
		this.#dead = true;
	}
}

// ---- the device and the app --------------------------------------------------------------------------------------------

// Reactive, as the layout's container is: a lock, an unlock and a flag set later all redraw the page.
const app = $state<ProfileApp>({
	status: 'ready',
	store: null,
	timeline: null,
	calendar: null,
	byok: null,
	cause: null,
	db: null,
	wipeAll: null,
	relockAll: null,
	joinRelock: null,
	publish: null,
	reloadOnUnlock: false,
	replacedNotice: false
});

const START_URL = location.href;
const START_STATE: unknown = history.state;
let db: IDBDatabase;
let store: ProfileStore | null = null;
let relockables: Relockable[] = [];
let held: { release: () => void } | null = null;
const wipeAll = vi.fn(async () => {});

type Device = {
	/** A saved profile makes a device with a timeline; none makes a first-run one, which Settings treats as no timeline. */
	profile: boolean;
	status?: 'ready' | 'damaged';
};

async function device({ profile, status = 'ready' }: Device): Promise<ProfileStore> {
	await wipeAllStores(db);
	await bootstrapLocalKeystore(db);
	const made = createProfileStore(db);
	if (profile) {
		await made.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
	}
	store = made;
	// A damaged device has no store to relock: its list starts empty and only a backup Check joins it.
	relockables = status === 'ready' ? [made] : [];
	app.status = status;
	app.store = status === 'ready' ? made : null;
	// The layout's one connection, ready or damaged.
	app.db = db;
	app.wipeAll = wipeAll;
	app.relockAll = () => relockAll(relockables, 'user');
	app.joinRelock = createJoinRelock(relockables);
	app.publish = status === 'ready' ? () => {} : null;
	app.reloadOnUnlock = false;
	return made;
}

/**
 * Holds every reload the page starts, recording where it was going. A change of the address by the history API is a
 * navigate event too, and it is not cancelable: it is left to happen, and the tests read the address itself.
 */
function holdNavigation(): { type: string; path: string }[] {
	const seen: { type: string; path: string }[] = [];
	const target = (window as unknown as { navigation: EventTarget }).navigation;
	const hold = (e: Event): void => {
		const nav = e as Event & { navigationType: string; destination: { url: string } };
		if (nav.navigationType !== 'reload') return;
		seen.push({ type: nav.navigationType, path: new URL(nav.destination.url).pathname });
		e.preventDefault();
	};
	target.addEventListener('navigate', hold);
	held = { release: () => target.removeEventListener('navigate', hold) };
	return seen;
}

const session = () => backupSession;

/** What the system chooser hands over: with no picker the session falls back to a file input in the body. */
function setPicker(picker: OpenPicker | undefined): void {
	Object.defineProperty(window, 'showOpenFilePicker', {
		configurable: true,
		writable: true,
		value: picker
	});
}

const realSavePicker = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker');

/**
 * The place the person picks for a backup, whose close() is held until `release`: the one moment a page can be hidden
 * after the save is final and before its answer is back.
 */
function savePlace(name: string) {
	const gate = deferred<void>();
	const place = { closes: 0, release: () => gate.resolve(), content: '' };
	let staged = '';
	const handle: SaveHandle = {
		name,
		getFile: async () => new File([place.content], name),
		createWritable: async () => ({
			write: async (data) => {
				staged = data;
			},
			close: async () => {
				place.closes += 1;
				await gate.promise;
				place.content = staged;
			},
			abort: async () => {}
		})
	};
	Object.defineProperty(window, 'showSaveFilePicker', {
		configurable: true,
		writable: true,
		value: () => Promise.resolve(handle)
	});
	return place;
}

beforeAll(async () => {
	db = await openTestDb();
});

afterAll(async () => {
	await deleteTestDb(db);
});

beforeEach(() => {
	harness.app = app;
	kdf.standIn = false;
	setPicker(undefined);
	// The headless browser dismisses a real file dialog at once, which would fire the input's cancel.
	vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
	// The page has no focus in a headless run, and the key step waits for it; the key worker is the pinned stand-in.
	vi.spyOn(document, 'hasFocus').mockReturnValue(true);
	vi.stubGlobal('Worker', HandlerWorker);
	app.status = 'ready';
	app.store = null;
	app.db = null;
	app.relockAll = null;
	app.joinRelock = null;
	app.publish = null;
	app.reloadOnUnlock = false;
	wipeAll.mockClear();
	writer.hold = null;
	// The erase also clears the device's settings and caches; the page under test shares both with other test files.
	vi.spyOn(Storage.prototype, 'clear').mockImplementation(() => {});
	vi.spyOn(CacheStorage.prototype, 'keys').mockResolvedValue([]);
});

afterEach(async () => {
	held?.release();
	held = null;
	if (backupSession.active) {
		// A finished restore ends its session only through `done`.
		backupSession.enterPhase('done');
		backupSession.end();
	}
	backupSession.committing = false;
	backupSession.takeEraseRequest();
	for (const input of document.body.querySelectorAll('input[type="file"]')) input.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (realSavePicker) Object.defineProperty(window, 'showSaveFilePicker', realSavePicker);
	else Reflect.deleteProperty(window, 'showSaveFilePicker');
	store?.relockSync('hygiene');
	store = null;
	app.store = null;
	history.replaceState(START_STATE, '', START_URL);
});

// ---- what a person finds on the page ---------------------------------------------------------------------------------

const backupHeading = () => page.getByRole('heading', { level: 2, name: 'Backup', exact: true });
const button = (name: string) => page.getByRole('button', { name, exact: true });
const toggle = (name: string, open: boolean) =>
	page.getByRole('button', { name, exact: true, expanded: open });
const dialogEl = () => document.querySelector<HTMLDialogElement>('dialog.wipe-dialog');
const dialogButton = (name: string) => page.getByRole('dialog').getByRole('button', { name });
const headings = () =>
	[...document.querySelectorAll('h2')].map((h) => h.textContent?.replace(/\s+/g, ' ').trim());

function deferred<T>() {
	let resolveIt!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolveIt = res;
	});
	return { promise, resolve: resolveIt };
}

const goldenFile = () => new File([goldenText], 'ask214-backup-2026-10-15-K7Q2.json');

/** Opens the Restore row and presses Choose file, leaving the chooser open. */
async function openChooser(): Promise<void> {
	await userEvent.click(toggle(CARD_LABELS.restore, false));
	await expect.poll(() => session().phase).toBe('choose-file');
	await userEvent.click(button(CARD_LABELS.chooseFile));
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Opens the Restore row and picks the golden backup, leaving the card at the passphrase. */
async function chooseGoldenFile(): Promise<void> {
	setPicker(async () => [{ getFile: async () => goldenFile() }]);
	await userEvent.click(toggle(CARD_LABELS.restore, false));
	await userEvent.click(button(CARD_LABELS.chooseFile));
	await expect.element(page.getByLabelText(CARD_LABELS.passphrase, { exact: true })).toBeVisible();
}

/** The whole way to the confirm a person sees before pressing Replace. */
async function restoreToConfirm(): Promise<void> {
	await chooseGoldenFile();
	await page.getByLabelText(CARD_LABELS.passphrase, { exact: true }).fill(GOLDEN_PASSWORD);
	await userEvent.click(
		page.getByRole('form', { name: CARD_LABELS.restore }).getByRole('button', {
			name: CARD_LABELS.restoreSubmit,
			exact: true
		})
	);
	await expect.element(page.getByRole('dialog')).toBeVisible();
}

const eraseCta = () => page.getByRole('button', { name: 'Erase all data on this device' });

/** Opens the Erase dialog from the Erase button and confirms it; the reload it ends in is held. */
async function eraseFromButton(): Promise<{ type: string; path: string }[]> {
	const seen = holdNavigation();
	await userEvent.click(eraseCta());
	await userEvent.click(dialogButton('Erase everything'));
	await vi.waitFor(() => expect(seen).toHaveLength(1));
	return seen;
}

// ---- the card's place and its lock ---------------------------------------------------------------------------------

describe('Settings, the Backup card', () => {
	it('sits after Privacy and security and ahead of the calendar and the online answers', async () => {
		await device({ profile: true });
		await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();

		const names = headings();
		const privacy = names.indexOf('Privacy and security');
		expect(privacy).toBeGreaterThan(-1);
		expect(names[privacy + 1]).toBe('Backup');
		// Something follows it: the card is not last, so the panels it split the gate around are still drawn.
		expect(names.length).toBeGreaterThan(privacy + 2);
	});

	// An app switch evicts the profile; the card, and the chooser the session put in the page body, must not go with it.
	it.each(['file input', 'file picker'] as const)(
		'a hygiene relock between Choose file and the file arriving keeps the card and reaches file-chosen (%s)',
		async (path) => {
			await device({ profile: true });
			const arrival = deferred<readonly { getFile: () => Promise<File> }[]>();
			if (path === 'file picker') setPicker(() => arrival.promise);
			await render(SettingsPage);
			await expect.element(backupHeading()).toBeVisible();
			await openChooser();
			const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
			if (path === 'file input') expect(input).not.toBeNull();

			relockEachSync(relockables, 'hygiene');

			await expect.element(button('Unlock')).toBeVisible();
			expect(store?.locked).toBe(true);
			await expect.element(backupHeading()).toBeVisible();
			if (path === 'file input') {
				expect(input?.isConnected).toBe(true);
				expect(document.body.querySelector('input[type="file"]')).toBe(input);
				const transfer = new DataTransfer();
				transfer.items.add(goldenFile());
				if (input) input.files = transfer.files;
				input?.dispatchEvent(new Event('change'));
			} else {
				arrival.resolve([{ getFile: async () => goldenFile() }]);
			}
			await expect.poll(() => session().phase).toBe('file-chosen');
		}
	);

	it('goes with a Lock, ends the backup, and comes back fresh on Unlock', async () => {
		await device({ profile: true });
		await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		await userEvent.click(toggle(CARD_LABELS.restore, false));
		await expect.poll(() => session().active).toBe(true);

		await userEvent.click(button('Lock'));
		await expect.element(button('Unlock')).toBeVisible();
		expect(backupHeading().query()).toBeNull();
		expect(session().active).toBe(false);

		await userEvent.click(button('Unlock'));
		await expect.element(backupHeading()).toBeVisible();
		await expect.element(toggle(CARD_LABELS.restore, false)).toBeVisible();
	});

	// A device with no profile has nothing to unlock: the locked panel never comes, so a card taken away by the lock would
	// not come back until the page is reloaded. Its session still ends on the lock.
	it('stays on a device with no profile after an idle lock, and the lock ends its session', async () => {
		await device({ profile: false });
		await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		await userEvent.click(toggle(CARD_LABELS.restore, false));
		await expect.poll(() => session().active).toBe(true);

		relockEachSync(relockables, 'idle');

		await expect.poll(() => session().active).toBe(false);
		expect(store?.lockState).toBe('locked');
		expect(button('Unlock').query()).toBeNull();
		await expect.element(backupHeading()).toBeVisible();
		await expect.element(toggle(CARD_LABELS.restore, false)).toBeVisible();
	});

	it('is not drawn for an evicted profile when no backup is running', async () => {
		await device({ profile: true });
		await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();

		relockEachSync(relockables, 'hygiene');

		await expect.element(button('Unlock')).toBeVisible();
		expect(backupHeading().query()).toBeNull();
	});

	// The person puts the phone down just after pressing Save: the page is hidden before the file's answer is back, and the
	// card is gone when it arrives. The result is theirs to read when they come back.
	it('shows the saved line when the card comes back after the page was hidden during the save', async () => {
		await device({ profile: true });
		kdf.standIn = true;
		const place = savePlace('kept.json');
		await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		await userEvent.click(toggle(CARD_LABELS.make, false));
		await userEvent.click(button(CARD_LABELS.show));
		const group = page.getByRole('group', { name: PHRASE_NOTE, exact: true });
		await expect.element(group).toBeVisible();
		const words = [...group.element().querySelectorAll('li')].map((li) => li.textContent).join(' ');
		await page.getByLabelText(CARD_LABELS.passphrase, { exact: true }).fill(words);
		await userEvent.click(
			page.getByRole('form', { name: CARD_LABELS.make }).getByRole('button', {
				name: CARD_LABELS.make,
				exact: true
			})
		);
		await expect.poll(() => place.closes).toBe(1);

		relockEachSync(relockables, 'hygiene');
		place.release();

		await expect.element(button('Unlock')).toBeVisible();
		await expect.poll(() => session().active).toBe(false);
		await expect.poll(() => backupHeading().query()).toBeNull();

		await userEvent.click(button('Unlock'));
		await expect.element(page.getByText(savedLine('kept.json'))).toBeVisible();
		expect(page.getByText(NO_BACKUP_YET_LINE).query()).toBeNull();
	});

	// The card was taken off behind the Lock, so it kept the result for the person's return; the person then went to another
	// page and unlocked there. Coming back to Settings is a new visit, not the return the result was kept for.
	it('does not bring a kept saved line back after the person left Settings while locked', async () => {
		await device({ profile: true });
		kdf.standIn = true;
		const place = savePlace('kept.json');
		const shown = await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		await userEvent.click(toggle(CARD_LABELS.make, false));
		await userEvent.click(button(CARD_LABELS.show));
		const group = page.getByRole('group', { name: PHRASE_NOTE, exact: true });
		await expect.element(group).toBeVisible();
		const words = [...group.element().querySelectorAll('li')].map((li) => li.textContent).join(' ');
		await page.getByLabelText(CARD_LABELS.passphrase, { exact: true }).fill(words);
		await userEvent.click(
			page.getByRole('form', { name: CARD_LABELS.make }).getByRole('button', {
				name: CARD_LABELS.make,
				exact: true
			})
		);
		place.release();
		await expect.element(page.getByText(savedLine('kept.json'))).toBeVisible();

		await userEvent.click(button('Lock'));
		await expect.element(button('Unlock')).toBeVisible();
		await shown.unmount();
		await store?.load();
		await render(SettingsPage);

		await expect.element(backupHeading()).toBeVisible();
		expect(page.getByText(savedLine('kept.json')).query()).toBeNull();
	});

	// A device with nothing to unlock reads 'locked' after another tab idles, and the person is still elsewhere once they
	// leave: the open step must not wait on a page they are no longer on.
	it('ends a restore on a device with no profile when the person leaves Settings after a peer lock', async () => {
		await device({ profile: false });
		const shown = await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		await userEvent.click(toggle(CARD_LABELS.restore, false));
		await expect.poll(() => session().phase).toBe('choose-file');
		relockEachSync(relockables, 'peer', { peerReason: 'idle' });
		expect(store?.lockState).toBe('locked');
		expect(session().active).toBe(true);

		await shown.unmount();

		await expect.poll(() => session().active).toBe(false);
	});

	it('says the restore finished and the device is locked, above the Unlock panel', async () => {
		await device({ profile: true });
		await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		await userEvent.click(toggle(CARD_LABELS.restore, false));
		await expect.poll(() => session().phase).toBe('choose-file');

		// The write is past its point of no return; a Lock now cannot stop it, only be written down. The Lock is a later
		// event than the commit, as it is for a person.
		session().committing = true;
		session().enterPhase('committed');
		relockAll(relockables, 'user');

		await expect.element(button('Unlock')).toBeVisible();
		expect(backupHeading().query()).toBeNull();
		await expect.element(page.getByText(LOCKED_AFTER_RESTORE_LINE)).toBeVisible();
		const line = page.getByText(LOCKED_AFTER_RESTORE_LINE).element();
		const panel = document.querySelector('.locked-panel');
		expect(
			line.compareDocumentPosition(panel as Node) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	// A Lock is a later event than the write that began: the restore finishes, the tab stays locked and says so, and no
	// reload decrypts the page the person just locked.
	it('says the backup was restored, and does not reload, when the Lock came during the write', async () => {
		await device({ profile: true });
		const written = deferred<void>();
		writer.hold = written.promise;
		const seen = holdNavigation();
		await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		await restoreToConfirm();
		await userEvent.click(button(CARD_LABELS.replace));
		await expect.poll(() => session().committing).toBe(true);

		await userEvent.click(button('Lock'));
		await expect.element(button('Unlock')).toBeVisible();
		written.resolve();
		await expect.poll(() => session().phase).toBe('committed');

		await expect.element(page.getByText(RESTORED_UNLOCK_LINE)).toBeVisible();
		expect(page.getByText(LOCKED_AFTER_RESTORE_LINE).query()).toBeNull();
		expect(app.reloadOnUnlock).toBe(true);
		await pause(100);
		expect(seen).toEqual([]);
	});

	// Another tab idling locks this profile and takes the card off the page; the person is still here, mid-restore.
	it('keeps a restore that has not begun writing when another tab idles, and finds it again on Unlock', async () => {
		await device({ profile: true });
		await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		await chooseGoldenFile();
		await expect.poll(() => session().phase).toBe('file-chosen');

		relockEachSync(relockables, 'peer', { peerReason: 'idle' });

		await expect.element(button('Unlock')).toBeVisible();
		expect(backupHeading().query()).toBeNull();
		await pause(100);
		expect(session().phase).toBe('file-chosen');

		await userEvent.click(button('Unlock'));
		await expect.element(toggle(CARD_LABELS.restore, true)).toBeVisible();
		await expect
			.element(page.getByLabelText(CARD_LABELS.passphrase, { exact: true }))
			.toBeVisible();
	});

	// The deferred read of the lock must not turn a real move to another page into a kept session.
	it('ends a restore that has not begun writing when the person leaves the page', async () => {
		await device({ profile: true });
		const shown = await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		await userEvent.click(toggle(CARD_LABELS.restore, false));
		await expect.poll(() => session().phase).toBe('choose-file');

		await shown.unmount();

		await expect.poll(() => session().active).toBe(false);
	});

	it('reloads on Unlock instead of reading, when a restore happened while locked', async () => {
		await device({ profile: true });
		await render(SettingsPage);
		await expect.element(button('Lock')).toBeVisible();
		await userEvent.click(button('Lock'));
		await expect.element(button('Unlock')).toBeVisible();
		app.reloadOnUnlock = true;
		const load = vi.spyOn(app.store as ProfileStore, 'load');
		const seen = holdNavigation();

		await userEvent.click(button('Unlock'));

		await vi.waitFor(() => expect(seen).toEqual([expect.objectContaining({ type: 'reload' })]));
		expect(load).not.toHaveBeenCalled();
		expect(store?.locked).toBe(true);
	});
});

// ---- the Erase dialog and where an Erase lands ----------------------------------------------------------------------------

describe('Settings, Erase', () => {
	it('says in the dialog that saved backup files and passphrases are not erased', async () => {
		await device({ profile: true });
		await render(SettingsPage);
		await userEvent.click(eraseCta());

		const body = document.querySelector('#wipe-dialog-body');
		expect(body?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
			"This permanently erases everything stored on this device - your separation date and any profile details. It can't be undone. The app itself stays, so it still opens offline. Backup files you saved, and backup passphrases saved in a password manager or on paper, are not erased. Delete them yourself if you no longer want them."
		);
	});

	it('lands an ordinary Erase on the page it was on, with no restore intent', async () => {
		await device({ profile: true });
		await render(SettingsPage);
		const seen = await eraseFromButton();

		expect(wipeAll).toHaveBeenCalledOnce();
		expect(seen[0]?.type).toBe('reload');
		expect(location.pathname).not.toBe(resolve('/wizard'));
		captureBackupIntent();
		expect(takeBackupIntent('restore-row')).toBe(false);
	});

	it('lands an Erase from the damaged view on the setup screen with the restore row open, with no Check', async () => {
		await device({ profile: false, status: 'damaged' });
		await render(SettingsPage);
		const seen = await eraseFromButton();

		expect(wipeAll).toHaveBeenCalledOnce();
		expect(seen[0]?.type).toBe('reload');
		expect(location.pathname).toBe(resolve('/wizard'));
		// Nothing about a backup is in the address bar: the note lives in the history entry's state.
		expect(location.search).toBe('');
		expect(location.hash).toBe('');
		captureBackupIntent();
		expect(takeBackupIntent('restore-row')).toBe(true);
	});

	it('still reloads, and says nothing failed, when the browser refuses the intent note', async () => {
		await device({ profile: false, status: 'damaged' });
		await render(SettingsPage);
		vi.spyOn(history, 'replaceState').mockImplementation(() => {
			throw new DOMException('E_TEST_HISTORY', 'SecurityError');
		});
		const seen = await eraseFromButton();

		expect(seen[0]?.type).toBe('reload');
		expect(page.getByRole('alert').query()).toBeNull();
	});

	// The setup screen has no Erase dialog; it sends the person here and Settings opens it.
	it('opens the dialog once for a request from the setup screen, and its Erase lands on the restore row', async () => {
		await device({ profile: false });
		session().requestErase();
		await render(SettingsPage);
		await vi.waitFor(() => expect(dialogEl()?.open).toBe(true));
		expect(session().eraseRequested).toBe(false);
		// A first-run device has no timeline, so no Erase button: the dialog is the only way.
		expect(eraseCta().query()).toBeNull();

		const seen = holdNavigation();
		await userEvent.click(dialogButton('Erase everything'));
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(wipeAll).toHaveBeenCalledOnce();
		expect(location.pathname).toBe(resolve('/wizard'));
		expect(location.search).toBe('');
		expect(location.hash).toBe('');
		captureBackupIntent();
		expect(takeBackupIntent('restore-row')).toBe(true);
	});

	it.each(['the Cancel button', 'the Escape key'] as const)(
		'forgets where the dialog came from when it is closed with %s',
		async (how) => {
			await device({ profile: true });
			session().requestErase();
			await render(SettingsPage);
			await vi.waitFor(() => expect(dialogEl()?.open).toBe(true));
			if (how === 'the Cancel button') await userEvent.click(dialogButton('Cancel'));
			else await userEvent.keyboard('{Escape}');
			await vi.waitFor(() => expect(dialogEl()?.open).toBe(false));

			await eraseFromButton();

			captureBackupIntent();
			expect(takeBackupIntent('restore-row')).toBe(false);
			expect(location.pathname).not.toBe(resolve('/wizard'));
		}
	);

	// The restore finds a device whose saved data is damaged (here a profile sidecar whose signature does not verify), on
	// one that has no timeline, so the page has no Erase button: the card's line is the only way to the dialog.
	it('opens a working Erase dialog from the damaged-device line, on a device with no timeline', async () => {
		await device({ profile: false });
		await withStores(db, 'profile-hwm', 'readwrite', (tx) => {
			tx.objectStore('profile-hwm').put({
				id: 0,
				payload: { generation: 1, ts: 1 },
				mac: new ArrayBuffer(32)
			});
		});
		setPicker(async () => [{ getFile: async () => goldenFile() }]);
		await render(SettingsPage);
		await expect.element(backupHeading()).toBeVisible();
		expect(eraseCta().query()).toBeNull();

		await userEvent.click(toggle(CARD_LABELS.restore, false));
		await userEvent.click(button(CARD_LABELS.chooseFile));
		const field = page.getByLabelText(CARD_LABELS.passphrase, { exact: true });
		await expect.element(field).toBeVisible();
		await field.fill(GOLDEN_PASSWORD);
		await userEvent.click(
			page.getByRole('form', { name: CARD_LABELS.restore }).getByRole('button', {
				name: CARD_LABELS.restoreSubmit,
				exact: true
			})
		);
		await userEvent.click(button(ERASE_DEVICE_BUTTON));

		await vi.waitFor(() => expect(dialogEl()?.open).toBe(true));
		const seen = holdNavigation();
		await userEvent.click(dialogButton('Erase everything'));
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(wipeAll).toHaveBeenCalledOnce();
		captureBackupIntent();
		expect(takeBackupIntent('restore-row')).toBe(true);
	}, 30_000);
});

// ---- a device whose saved data is damaged ----------------------------------------------------------------------------

describe('Settings, when the saved data cannot be read', () => {
	it('offers a Check beside the Erase, and Erase ends an open Check before it wipes', async () => {
		await device({ profile: false, status: 'damaged' });
		let activeAtWipe: boolean | null = null;
		wipeAll.mockImplementationOnce(async () => {
			activeAtWipe = session().active;
		});
		await render(SettingsPage);

		await expect
			.element(
				page.getByText(
					'Have a backup? Check it first, then erase and restore it on the setup screen.'
				)
			)
			.toBeVisible();
		await expect.element(eraseCta()).toBeVisible();
		await userEvent.click(toggle(CARD_LABELS.check, false));
		await expect.poll(() => session().kind).toBe('check');

		await eraseFromButton();

		expect(activeAtWipe).toBe(false);
	});

	// Nothing can be made or restored over damaged data, so the rows that could not start are not drawn, nor is the card's
	// intro or its list of what a backup leaves out.
	it('shows the Check row alone', async () => {
		await device({ profile: false, status: 'damaged' });
		await render(SettingsPage);

		await expect.element(toggle(CARD_LABELS.check, false)).toBeVisible();
		expect(button(CARD_LABELS.make).query()).toBeNull();
		expect(button(CARD_LABELS.restore).query()).toBeNull();
		expect(backupHeading().query()).toBeNull();
		expect(document.body.textContent).not.toContain(CARD_INTRO_LINE);
		expect(document.body.textContent).not.toContain(NOT_IN_BACKUPS_LEAD);
		// The row still works: it opens to the chooser.
		await userEvent.click(toggle(CARD_LABELS.check, false));
		await expect.element(button(CARD_LABELS.chooseFile)).toBeVisible();
	});
});
