import { render } from 'vitest-browser-svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import WizardPage from './+page.svelte';
import { ERASE_DEVICE_BUTTON } from '$lib/backup/copy';
import {
	ExportFlow,
	type SaveHandle,
	type SavePicker,
	type SaveWritable
} from '$lib/backup/export-flow';
import { markBackupIntent } from '$lib/backup/intent';
import { backupSession, BackupSession, type WorkerLike } from '$lib/backup/session.svelte';
import type { FromWorker, WorkerRequest } from '$lib/backup/worker/protocol';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { createJoinRelock } from '$lib/profile/app-init';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore, type ProfileStore } from '$lib/profile/store.svelte';

// The setup screen is driven the way a person drives it: the real page, the real card, the real session and flows, and
// a real IndexedDB behind them. Only what a person cannot touch is stood in for: the key worker (a quick stand-in for
// the 128 MiB derive), the file chooser, the wait for the offline worker, and the router.

const rig = vi.hoisted(() => ({
	app: null as unknown,
	db: null as IDBDatabase | null,
	createWorker: null as (() => unknown) | null,
	file: null as File | null,
	goto: vi.fn<(url: string) => Promise<void>>()
}));
const goto = rig.goto;

vi.mock('$lib/profile/context', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/profile/context')>()),
	getProfileApp: () => rig.app
}));
vi.mock('$app/navigation', () => ({ goto: rig.goto }));
vi.mock('$lib/ask/when-controlled', () => ({ waitForControl: () => Promise.resolve(true) }));
vi.mock('$lib/backup/session.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/backup/session.svelte')>();
	return {
		...actual,
		backupSession: new actual.BackupSession({
			isVisible: () => true,
			hasFocus: () => true,
			createWorker: () => rig.createWorker?.() as WorkerLike,
			getOpenPicker: () => async () => [{ getFile: async () => rig.file as File }]
		})
	};
});

const ENTRY = 'Moving to a new phone? Restore from a backup';
const NEW_LEAD =
	'Everything stays encrypted on this device. It leaves only if you make a backup, which is locked with your passphrase.';
const WORDS = ['bamboo', 'copper', 'harvest', 'lantern', 'oxygen', 'thimble'];
const TYPED = WORDS.join(' ');
const START_URL = location.href;
const START_STATE: unknown = history.state;
const INTENT_KEY = 'mtcBackupIntent';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function keyFor(pass: ArrayBuffer, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations: 1, hash: 'SHA-256' },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

class FakeKeyWorker implements WorkerLike {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessageerror: ((event: unknown) => void) | null = null;
	#dead = false;

	postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
		const sent = transfer.length > 0 ? structuredClone(message, { transfer }) : message;
		void this.#answer(sent);
	}

	terminate(): void {
		this.#dead = true;
	}

	async #answer(message: WorkerRequest): Promise<void> {
		if (message.op === 'generate') {
			this.onmessage?.({ data: { type: 'words', words: WORDS } satisfies FromWorker });
			return;
		}
		const key = await keyFor(message.pass, message.salt);
		if (!this.#dead) this.onmessage?.({ data: { type: 'key', key } satisfies FromWorker });
	}
}

// ---- the devices and the backup file -----------------------------------------------------------------------------

let db: IDBDatabase;
let profile: ProfileStore | null = null;

/** A phone that was just set up: a key and nothing saved yet, which is what the setup screen runs on. */
async function freshDevice(): Promise<IDBDatabase> {
	const database = await openTestDb();
	await bootstrapLocalKeystore(database);
	return database;
}

function saveTarget(): SaveHandle {
	let staged = '';
	let content = '';
	const writable: SaveWritable = {
		write: async (data) => {
			staged = data;
		},
		close: async () => {
			content = staged;
		},
		abort: () => Promise.resolve()
	};
	return {
		name: 'picked.json',
		getFile: () => Promise.resolve(new File([content], 'picked.json')),
		createWritable: async () => writable
	};
}

// One backup file, made once the way the app makes one: through the real export flow on a throwaway device.
let FILE_TEXT = '';

beforeAll(async () => {
	rig.createWorker = () => new FakeKeyWorker();
	const old = await freshDevice();
	const store = createProfileStore(old);
	try {
		await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		const session = new BackupSession({
			isVisible: () => true,
			hasFocus: () => true,
			createWorker: () => new FakeKeyWorker()
		});
		session.start({ status: 'ready', joinRelock: () => () => {}, publish: () => {} }, 'export');
		await session.showPassphrase();
		session.enterPhase('typed-back');
		const target = saveTarget();
		const picker: SavePicker = () => Promise.resolve(target);
		const flow = new ExportFlow({
			session,
			db: old,
			profile: store,
			getSavePicker: () => picker
		});
		const result = await flow.submit({ preventDefault: () => {} }, TYPED);
		if (result.kind !== 'saved') throw new Error('E_TEST_NO_BACKUP');
		FILE_TEXT = new TextDecoder().decode(await (await target.getFile()).arrayBuffer());
	} finally {
		store.relockSync('hygiene');
		await deleteTestDb(old);
	}
}, 60_000);

afterAll(() => {
	history.replaceState(START_STATE, '', START_URL);
});

// ---- the app the page runs in ----------------------------------------------------------------------------------

type AppOver = { status?: ProfileApp['status']; ready?: boolean };

// The layout hands over its one connection when start-up resolves, so an app still starting has none.
function makeApp(over: AppOver = {}) {
	const ready = over.ready ?? true;
	const app = $state({
		status: over.status ?? 'ready',
		store: null as ProfileApp['store'],
		db: ready ? rig.db : null,
		joinRelock: ready ? createJoinRelock([]) : null,
		publish: ready ? (): void => {} : null,
		reloadOnUnlock: false,
		replacedNotice: false
	});
	rig.app = app;
	return app;
}

beforeEach(async () => {
	goto.mockReset().mockResolvedValue(undefined);
	db = await freshDevice();
	rig.db = db;
	rig.file = new File([FILE_TEXT], 'ask214-backup-2026-10-15-K7Q2.json');
	profile = null;
});

afterEach(async () => {
	backupSession.relockSync('user');
	backupSession.takeEraseRequest();
	profile?.relockSync('hygiene');
	rig.db = null;
	await deleteTestDb(db);
	history.replaceState(START_STATE, '', START_URL);
});

const entry = () => page.getByRole('button', { name: ENTRY, exact: true });
const field = () => page.getByLabelText('Passphrase', { exact: true });
const intentOnEntry = (): unknown =>
	(history.state as Record<string, unknown> | null)?.[INTENT_KEY];

/** What the Erase from the damaged view leaves behind for this page: the note, with the address kept as it is. */
function leaveRestoreNote(): void {
	markBackupIntent('restore-row', location.pathname + location.search + location.hash);
}

/** Choose the backup file, type the words and press Restore. */
async function restoreFromRow(): Promise<void> {
	await userEvent.click(page.getByRole('button', { name: 'Choose file', exact: true }));
	await expect.element(field()).toBeVisible();
	await field().fill(TYPED);
	await userEvent.click(page.getByRole('button', { name: 'Restore', exact: true }));
}

describe('Wizard, the way to restore a backup', () => {
	it('offers one row, "Moving to a new phone? Restore from a backup", and no other backup row', async () => {
		makeApp();
		await render(WizardPage);

		await expect.element(entry()).toBeVisible();
		expect(entry().element().getAttribute('aria-expanded')).toBe('false');
		const body = document.body.textContent ?? '';
		expect(body).not.toContain('Make a backup');
		expect(body).not.toContain('Check a backup');
		// The screen's own button is still there beside it.
		await expect.element(page.getByRole('button', { name: 'Save and continue' })).toBeVisible();
	});

	it('a restore from the setup screen reaches the confirm', async () => {
		makeApp();
		await render(WizardPage);
		await userEvent.click(entry());
		await restoreFromRow();

		const dialog = page.getByRole('dialog');
		await expect.element(dialog).toBeVisible();
		expect(dialog.element().textContent).toContain('Ask 214 backup 2026-10-15 K7Q2');
	});

	// The app's one connection stays open when the person leaves, so a return visit restores on it as the first did.
	it('still restores after the person left the setup screen and came back', async () => {
		makeApp();
		const first = await render(WizardPage);
		await userEvent.click(entry());
		await expect.element(page.getByRole('button', { name: 'Choose file' })).toBeVisible();
		await first.unmount();
		backupSession.relockSync('user');

		await render(WizardPage);
		await userEvent.click(entry());
		await restoreFromRow();

		await expect.element(page.getByRole('dialog')).toBeVisible();
	});

	// The app has no connection to give until start-up resolves, so there is nothing for a row to run on.
	it('is not drawn while the app is starting, and opens on a tap once it is ready', async () => {
		const app = makeApp({ status: 'loading', ready: false });
		await render(WizardPage);
		await expect.element(page.getByRole('heading', { name: 'Set up your profile' })).toBeVisible();
		expect(entry().query()).toBeNull();

		app.db = db;
		app.joinRelock = createJoinRelock([]);
		app.publish = () => {};
		app.status = 'ready';
		await expect.element(entry()).toBeVisible();
		await userEvent.click(entry());
		await expect.element(page.getByRole('button', { name: 'Choose file' })).toBeVisible();
	});

	// A device whose saved data is damaged has the connection but cannot take a restore: the entry is guarded, not merely
	// switched off, so a tap does nothing and a screen reader hears it is off.
	it('is inert on a device whose saved data is damaged', async () => {
		const app = makeApp({ status: 'damaged' });
		app.publish = null;
		await render(WizardPage);
		await expect.element(entry()).toBeVisible();

		const el = entry().element() as HTMLButtonElement;
		expect(el.disabled).toBe(false);
		expect(el.getAttribute('aria-disabled')).toBe('true');
		el.click();
		await pause(100);
		expect(el.getAttribute('aria-expanded')).toBe('false');
		expect(page.getByRole('button', { name: 'Choose file' }).query()).toBeNull();
	});
});

describe('Wizard, after an Erase from the damaged view', () => {
	it('opens the restore row from the note and clears it, so a reload or a return finds it closed', async () => {
		makeApp();
		leaveRestoreNote();
		expect(intentOnEntry()).toBe('restore-row');

		const first = await render(WizardPage);
		await expect.element(entry()).toBeVisible();
		await expect.poll(() => entry().element().getAttribute('aria-expanded')).toBe('true');
		await expect.element(page.getByRole('button', { name: 'Choose file' })).toBeVisible();
		expect(intentOnEntry()).toBeUndefined();

		// Closed by the person, it stays closed; the note is not read again.
		await userEvent.click(entry());
		await expect.element(page.getByRole('button', { name: 'Choose file' })).not.toBeInTheDocument();
		await pause(100);
		expect(entry().element().getAttribute('aria-expanded')).toBe('false');
		await first.unmount();

		backupSession.relockSync('user');
		await render(WizardPage);
		await expect.element(entry()).toBeVisible();
		await pause(100);
		expect(entry().element().getAttribute('aria-expanded')).toBe('false');
	});

	// A reload while the app is still starting must not lose the note: it is taken as the page starts, and the row
	// opens once the app can run it.
	it('takes the note while the app is still starting and opens the row when it is ready', async () => {
		const app = makeApp({ status: 'loading', ready: false });
		leaveRestoreNote();
		await render(WizardPage);
		await expect.element(page.getByRole('heading', { name: 'Set up your profile' })).toBeVisible();

		expect(intentOnEntry()).toBeUndefined();
		expect(entry().query()).toBeNull();

		app.db = db;
		app.joinRelock = createJoinRelock([]);
		app.publish = () => {};
		app.status = 'ready';
		await expect.poll(() => entry().element().getAttribute('aria-expanded')).toBe('true');
		await expect.element(page.getByRole('button', { name: 'Choose file' })).toBeVisible();
	});

	it('ignores a note it does not know and leaves the row closed', async () => {
		makeApp();
		history.replaceState({ ...(history.state ?? {}), [INTENT_KEY]: 'restored' }, '');
		await render(WizardPage);
		await expect.element(entry()).toBeVisible();
		await pause(100);
		expect(entry().element().getAttribute('aria-expanded')).toBe('false');
		expect(intentOnEntry()).toBe('restored');
	});
});

describe('Wizard, a device the restore finds damaged', () => {
	async function damagedDevice(): Promise<void> {
		profile = createProfileStore(db);
		await profile.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		// The profile says a body was saved, and none is there: the device reads as damaged.
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction('profile', 'readwrite');
			tx.objectStore('profile').delete(0);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	it('navigates to Settings and asks for the Erase once', async () => {
		makeApp();
		await damagedDevice();
		await render(WizardPage);
		await userEvent.click(entry());
		await restoreFromRow();

		await userEvent.click(page.getByRole('button', { name: ERASE_DEVICE_BUTTON, exact: true }));
		expect(goto).toHaveBeenCalledTimes(1);
		expect(goto).toHaveBeenCalledWith('/settings');
		// Settings takes the request once; a second look finds nothing.
		expect(backupSession.takeEraseRequest()).toBe(true);
		expect(backupSession.takeEraseRequest()).toBe(false);
	});
});

describe('Wizard, what it says about where the data goes', () => {
	it('no longer says the data never leaves, and says when it does', async () => {
		makeApp();
		await render(WizardPage);

		await expect.element(page.getByText(NEW_LEAD)).toBeVisible();
		expect(document.body.textContent).not.toContain('never leaves');
		expect(document.body.textContent).toContain(
			"Add your separation date and we'll build a transition timeline around it."
		);
	});
});
