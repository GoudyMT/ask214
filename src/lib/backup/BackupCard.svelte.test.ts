import { render } from 'vitest-browser-svelte';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { createJoinRelock, relockEachSync, type Relockable } from '../profile/app-init';
import type { ProfileApp } from '../profile/context';
import type { RelockReason } from '../profile/lifecycle';
import {
	createProfileStore,
	KeystoreNotInitializedError,
	readDeviceState,
	readKeystoreRow,
	type DeviceState,
	type ProfileStore
} from '../profile/store.svelte';
import BackupCard from './BackupCard.svelte';
import {
	backupMessage,
	CARD_INTRO_LINE,
	CARD_LABELS,
	CHECK_NEW_BACKUP_OFFER,
	checkOpensLine,
	DEVICE_NEWER_WARNING,
	downloadedLine,
	ERASE_DEVICE_BUTTON,
	FINISH_SETUP_LINE,
	GETTING_READY_LINE,
	HIDDEN_WHILE_AWAY_LINE,
	KEEP_WORDS_LINE,
	lastBackupLine,
	MAKE_NEW_BACKUP_BUTTON,
	NO_BACKUP_YET_LINE,
	NOT_IN_BACKUPS,
	NOT_IN_BACKUPS_LEAD,
	notCheckedLine,
	ONLY_RESTORE_YOURS_LINE,
	PHRASE_NOTE,
	RESTORED_UNLOCK_LINE,
	savedLine,
	STOPPING_LINE,
	TYPE_BACK_LINE
} from './copy';
import { formatBackupDate } from './dates';
import { ExportFlow, type SaveHandle, type SavePicker, type SaveWritable } from './export-flow';
import { BackupSession, type OpenPicker, type WorkerLike } from './session.svelte';
import type { FromWorker, WorkerRequest } from './worker/protocol';

// The card is driven the way a person drives it: real taps, real keys, the real session and the real flows behind it.
// Only the seams a person cannot touch are faked: the key worker (a quick stand-in for the 128 MiB derive), the file
// pickers, the page's visibility and the reload. IndexedDB and the stores are the real ones.

const WORDS = ['bamboo', 'copper', 'harvest', 'lantern', 'oxygen', 'thimble'];
const TYPED = WORDS.join(' ');
const WRONG = 'bamboo copper harvest lantern oxygen thimbl';
const OUR_NAME = 'ask214-backup-2026-10-15-K7Q2.json';
const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};
const START_URL = location.href;
const START_STATE: unknown = history.state;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function need<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error('test setup: value missing');
	return value;
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// ---- the key worker ------------------------------------------------------------------------------------------------

// How long the stand-in takes to answer a derive, so a held key finds the work still going (100) or already done (0).
const timing = { ms: 0, silent: false };

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
		if (timing.silent) return;
		const key = await keyFor(message.pass, message.salt);
		await pause(timing.ms);
		if (!this.#dead) this.onmessage?.({ data: { type: 'key', key } satisfies FromWorker });
	}
}

// ---- a save target the person picked ---------------------------------------------------------------------------------

function fakeFile(over: { existing?: string; name?: string } = {}) {
	const f = {
		name: over.name ?? 'picked.json',
		content: over.existing ?? '',
		staged: null as string | null,
		writes: 0,
		closes: 0,
		reads: 0,
		closeGate: null as Deferred<void> | null,
		failClose: false,
		mangle: false,
		readBack: 'ok' as 'ok' | 'reject',
		handle: null as unknown as SaveHandle
	};
	const writable: SaveWritable = {
		write: async (data) => {
			f.writes += 1;
			f.staged = data;
		},
		close: async () => {
			f.closes += 1;
			await f.closeGate?.promise;
			if (f.failClose) throw new Error('E_TEST');
			f.content = (f.staged ?? '') + (f.mangle ? ' ' : '');
		},
		abort: () => Promise.resolve()
	};
	f.handle = {
		name: f.name,
		getFile: () => {
			f.reads += 1;
			// The first read is the check for an existing file; a later one is the read-back.
			if (f.reads > 1 && f.readBack === 'reject') return Promise.reject(new Error('E_TEST'));
			return Promise.resolve(new File([f.content], f.name));
		},
		createWritable: async () => writable
	};
	return f;
}

function pickerOf(...answers: (SaveHandle | Error | { after: number; error: Error })[]) {
	const queue = [...answers];
	return vi.fn<SavePicker>(() => {
		const next = queue.shift();
		if (next === undefined) return Promise.reject(new Error('E_TEST_NO_ANSWER'));
		if (next instanceof Error) return Promise.reject(next);
		if ('after' in next) {
			return new Promise<SaveHandle>((_, reject) =>
				setTimeout(() => reject(next.error), next.after)
			);
		}
		return Promise.resolve(next);
	});
}

const userCancel = () => new DOMException('The user aborted a request.', 'AbortError');

// ---- the device and the app --------------------------------------------------------------------------------------

let db: IDBDatabase;
let profile: ProfileStore;
const sessions: BackupSession[] = [];

async function newDevice(): Promise<{ db: IDBDatabase; profile: ProfileStore }> {
	const database = await openTestDb();
	await bootstrapLocalKeystore(database);
	const store = createProfileStore(database);
	await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
	return { db: database, profile: store };
}

async function realRead(
	database: IDBDatabase
): Promise<{ state: DeviceState; installUuid: Uint8Array }> {
	const keystore = await readKeystoreRow(database);
	return {
		state: await readDeviceState(database),
		installUuid: new Uint8Array(keystore.installUuid)
	};
}

// One backup file for every test that needs a good one, made once the way the app makes one (through the real export
// flow on a throwaway device).
let FILE_TEXT = '';
let FILE_MADE_AT = 0;

beforeAll(async () => {
	const device = await newDevice();
	try {
		const session = new BackupSession({
			isVisible: () => true,
			hasFocus: () => true,
			createWorker: () => new FakeKeyWorker()
		});
		session.start({ status: 'ready', joinRelock: () => () => {}, publish: () => {} }, 'export');
		await session.showPassphrase();
		session.enterPhase('typed-back');
		const target = fakeFile();
		const flow = new ExportFlow({
			session,
			db: device.db,
			profile: device.profile,
			getSavePicker: () => pickerOf(target.handle)
		});
		FILE_MADE_AT = Date.now();
		const result = await flow.submit({ preventDefault: () => {} }, TYPED);
		if (result.kind !== 'saved') throw new Error('E_TEST_NO_BACKUP');
		FILE_TEXT = target.content;
	} finally {
		device.profile.relockSync('hygiene');
		await deleteTestDb(device.db);
	}
}, 60_000);

afterAll(() => {
	history.replaceState(START_STATE, '', START_URL);
});

// ---- the rig -------------------------------------------------------------------------------------------------------

type Mount = {
	status?: ProfileApp['status'];
	joinRelock?: boolean;
	publish?: boolean;
	/** What the save picker answers, in order; the default is one empty file. */
	picker?: SavePicker | null;
	file?: ReturnType<typeof fakeFile>;
	wait?: () => Promise<boolean>;
	readDevice?: (database: IDBDatabase) => Promise<{ state: DeviceState; installUuid: Uint8Array }>;
	chooser?: 'api' | 'input';
	readBackMs?: number;
};

async function mount(o: Mount = {}) {
	const relockables: Relockable[] = [];
	const joinRelock = createJoinRelock(relockables);
	joinRelock({
		relockSync: (reason) => profile.relockSync(reason),
		refresh: () => Promise.resolve()
	});
	const visible = { value: true };
	const workers: FakeKeyWorker[] = [];
	const chosen: { file: File | null; gate: Deferred<void> | null } = { file: null, gate: null };
	const openPicker = vi.fn<OpenPicker>(async () => {
		// Read at the call, answered later when the test holds the picker: the person is still choosing.
		const held = chosen.gate;
		const answer = chosen.file;
		if (held !== null) await held.promise;
		return answer === null && held === null
			? []
			: [{ getFile: async () => need(answer ?? chosen.file) }];
	});
	const session = new BackupSession({
		isVisible: () => visible.value,
		hasFocus: () => true,
		createWorker: () => {
			const worker = new FakeKeyWorker();
			workers.push(worker);
			return worker;
		},
		getOpenPicker: o.chooser === 'input' ? () => null : () => openPicker
	});
	sessions.push(session);
	const published: unknown[] = [];
	const app: Pick<ProfileApp, 'status' | 'joinRelock' | 'publish' | 'store' | 'reloadOnUnlock'> = {
		status: o.status ?? 'ready',
		joinRelock: o.joinRelock === false ? null : joinRelock,
		publish: o.publish === false ? null : (signal) => void published.push(signal),
		store: profile,
		reloadOnUnlock: false
	};
	const file = o.file ?? fakeFile();
	const picker = o.picker === undefined ? pickerOf(file.handle) : o.picker;
	const getSavePicker = vi.fn(() => picker);
	const download = vi.fn<(fileName: string, text: string) => void>();
	const reload = vi.fn<() => void>();
	const replace = vi.fn<(path: string) => void>();
	const onEraseRequest = vi.fn<() => void>();
	const props = {
		app,
		db,
		session,
		onEraseRequest,
		exportDeps: { getSavePicker, download, readBackMs: o.readBackMs ?? 500 },
		restoreDeps: {
			waitForControl: o.wait ?? (() => Promise.resolve(true)),
			readDevice:
				o.readDevice ??
				(async (database: IDBDatabase) => {
					await pause(timing.ms);
					return realRead(database);
				}),
			reload,
			replace,
			isVisible: () => visible.value,
			onceVisible: () => () => {}
		}
	};
	const rendered = await render(BackupCard, { props });
	return {
		...rendered,
		/** Mounts the card again over the same session, as Settings does when it brings the card back after an Unlock. */
		remount: () => render(BackupCard, { props }),
		session,
		app,
		workers,
		visible,
		file,
		picker,
		openPicker,
		published,
		download,
		getSavePicker,
		reload,
		replace,
		onEraseRequest,
		/** Delivers a file to the next "Choose file". */
		choose: (f: File | null) => {
			chosen.file = f;
		},
		/** The next picker stays open until the returned function is called: the person is still choosing. */
		holdPicker: () => {
			const gate = deferred<void>();
			chosen.gate = gate;
			return () => gate.resolve();
		},
		relock: (reason: RelockReason) => relockEachSync(relockables, reason)
	};
}

type Card = Awaited<ReturnType<typeof mount>>;

beforeEach(async () => {
	({ db, profile } = await newDevice());
	timing.ms = 0;
	timing.silent = false;
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) session.relockSync('user');
	profile.relockSync('hygiene');
	await deleteTestDb(db);
	history.replaceState(START_STATE, '', START_URL);
});

// ---- what a person finds on the card ---------------------------------------------------------------------------------

const toggle = (name: string, open: boolean) =>
	page.getByRole('button', { name, exact: true, expanded: open });
const button = (name: string) => page.getByRole('button', { name, exact: true });
const field = () => page.getByLabelText(CARD_LABELS.passphrase, { exact: true });
const phrase = () => page.getByRole('group', { name: PHRASE_NOTE, exact: true });
const shownWords = () =>
	[...phrase().element().querySelectorAll('li')].map((item) => item.textContent);
const formOf = (name: string) => page.getByRole('form', { name });
const submitOf = (form: string, name = form) =>
	formOf(form).getByRole('button', { name, exact: true });
const text = (value: string) => page.getByText(value, { exact: true });
const fieldEl = () => field().element() as HTMLInputElement;

async function showWords(): Promise<void> {
	await userEvent.click(button(CARD_LABELS.show));
	await expect.element(phrase()).toBeVisible();
}

/** The Make row, open, with the words shown and typed back (not yet submitted). */
async function typedBack(card: Card, typed = TYPED): Promise<void> {
	await userEvent.click(toggle(CARD_LABELS.make, false));
	await showWords();
	await field().fill(typed);
	expect(card.session.phase).not.toBe('idle');
}

const backupFile = (name = OUR_NAME) => new File([FILE_TEXT], name);

/** A restore or Check row, open, with the file chosen and the field showing. */
async function fileChosen(card: Card, row: 'restore' | 'check'): Promise<void> {
	card.choose(backupFile());
	await userEvent.click(toggle(row === 'restore' ? CARD_LABELS.restore : CARD_LABELS.check, false));
	await userEvent.click(button(CARD_LABELS.chooseFile));
	await expect.element(field()).toBeVisible();
}

async function holdEnter(repeats = 6): Promise<void> {
	const session = cdp();
	await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
	for (let i = 0; i < repeats; i += 1) {
		// A held key repeats about every 40 ms.
		await pause(40);
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
	}
	await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
}

const TIMINGS = [0, 100] as const;

// ---- the card at rest ------------------------------------------------------------------------------------------------

describe('the card at rest', () => {
	it('shows the file line, three closed rows and what no backup holds, and tells the translator to leave it', async () => {
		await mount();
		const region = page.getByRole('region', { name: CARD_LABELS.heading, exact: true });
		await expect.element(region).toBeVisible();
		expect(region.element().getAttribute('translate')).toBe('no');
		await expect.element(text(CARD_INTRO_LINE)).toBeVisible();
		for (const name of [CARD_LABELS.make, CARD_LABELS.restore, CARD_LABELS.check]) {
			await expect.element(toggle(name, false)).toBeVisible();
			expect(toggle(name, false).element().getAttribute('aria-disabled')).toBe('false');
		}
		await expect.element(text(NOT_IN_BACKUPS_LEAD)).toBeVisible();
		for (const item of NOT_IN_BACKUPS) await expect.element(text(item)).toBeVisible();
		expect(phrase().query()).toBeNull();
	});

	it.each<[string, number | null]>([
		['no mark', null],
		['a mark', Date.UTC(2026, 9, 12, 20, 0, 0)]
	])('Last backup shows the date of the mark, or No backup yet (%s)', async (_name, at) => {
		if (at !== null) {
			await profile.save({
				lastBackupAt: at,
				backupGenProfile: 2,
				backupGenTimeline: 0,
				backupGenCalendar: 0
			});
		}
		await mount();
		if (at === null) {
			await expect.element(text(NO_BACKUP_YET_LINE)).toBeVisible();
			return;
		}
		await expect.element(text(lastBackupLine(formatBackupDate(at)))).toBeVisible();
		expect(text(NO_BACKUP_YET_LINE).query()).toBeNull();
	});

	// A row must not start work the app cannot protect: no relock set, an app still loading, or no way to tell the other tabs.
	it.each<[string, Mount, string]>([
		['the app is still loading', { status: 'loading' }, CARD_LABELS.make],
		['the app has no relock set yet', { joinRelock: false }, CARD_LABELS.check],
		['a restore cannot tell the other tabs', { publish: false }, CARD_LABELS.restore]
	])('a row stays closed when %s', async (_why, opts, row) => {
		const card = await mount(opts);
		// A plain click: the browser's own click helper waits for an enabled control, and this one says it is not.
		(toggle(row, false).element() as HTMLElement).click();
		await pause(50);
		expect(card.session.phase).toBe('idle');
		await expect.element(toggle(row, false)).toBeVisible();
		expect(text(GETTING_READY_LINE).query()).toBeNull();
		// Inert, not broken: the tap starts nothing and raises no error line, and a screen reader is told it is off.
		expect(page.getByRole('status').query()).toBeNull();
		expect(toggle(row, false).element().getAttribute('aria-disabled')).toBe('true');
	});

	// A start the app refuses is not an unfinished setup: the line must not blame the person's setup for it.
	it('a start the session refuses says that the step stopped, not that setup is unfinished', async () => {
		const card = await mount();
		const real = card.app.joinRelock;
		let reads = 0;
		// Open to the card's own check, gone by the time the session looks.
		Object.defineProperty(card.app, 'joinRelock', {
			configurable: true,
			get: () => (reads++ === 0 ? real : null)
		});
		reads = 0;
		await userEvent.click(toggle(CARD_LABELS.make, false));
		await expect
			.element(text(need(backupMessage('E_WORKER_FAILED', { path: 'export' }))))
			.toBeVisible();
		expect(text(FINISH_SETUP_LINE).query()).toBeNull();
	});

	// The toggle keeps focus through the press, so a repeat of the held key lands on it again and would close the row it
	// just opened, then open it again.
	it.each(TIMINGS)(
		'a held Enter on a row toggle opens the row once (the wait takes %i ms)',
		async (ms) => {
			const wait = vi.fn(() => pause(ms).then(() => true));
			const card = await mount({ wait });
			(toggle(CARD_LABELS.restore, false).element() as HTMLElement).focus();
			await holdEnter();
			await pause(100);
			expect(wait).toHaveBeenCalledTimes(1);
			await expect.element(toggle(CARD_LABELS.restore, true)).toBeVisible();
			expect(card.session.kind).toBe('restore');
		}
	);

	it('Check still opens when the saved data is damaged', async () => {
		const card = await mount({ status: 'damaged' });
		await userEvent.click(toggle(CARD_LABELS.check, false));
		await expect.element(button(CARD_LABELS.chooseFile)).toBeVisible();
		expect(card.session.kind).toBe('check');
	});
});

// ---- Make a backup: the words ------------------------------------------------------------------------------------------

describe('the words', () => {
	// The words must not be in the page, or on the way to it, until the person asks to see them.
	it('are not in the page, and no key worker exists, before Show my passphrase', async () => {
		const card = await mount();
		await userEvent.click(toggle(CARD_LABELS.make, false));
		await expect.element(button(CARD_LABELS.show)).toBeVisible();
		expect(phrase().query()).toBeNull();
		expect(card.workers).toHaveLength(0);
		expect(card.session.words).toBeNull();
		for (const word of WORDS) expect(document.body.textContent).not.toContain(word);
		// Said before the words appear: where to keep them, and that a forgotten passphrase cannot be recovered.
		await expect.element(text(KEEP_WORDS_LINE)).toBeVisible();

		await showWords();
		expect(card.workers).toHaveLength(1);
		expect(shownWords()).toEqual(WORDS);
		await expect.element(text(PHRASE_NOTE)).toBeVisible();
	});

	it('cannot be selected', async () => {
		await mount();
		await userEvent.click(toggle(CARD_LABELS.make, false));
		await showWords();
		expect(getComputedStyle(phrase().element()).userSelect).toBe('none');
	});

	it.each(['copy', 'cut'])('refuse a %s of the words', async (kind) => {
		await mount();
		await userEvent.click(toggle(CARD_LABELS.make, false));
		await showWords();
		const event = new ClipboardEvent(kind, { bubbles: true, cancelable: true });
		phrase().element().dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});

	// Paste stays open on the field (a password manager and a person with a motor impairment both need it).
	it('let a paste into the type-back field through', async () => {
		await mount();
		await userEvent.click(toggle(CARD_LABELS.make, false));
		await showWords();
		const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
		field().element().dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	it('are hidden by Hide words and come back, the same six, with focus following', async () => {
		await mount();
		await userEvent.click(toggle(CARD_LABELS.make, false));
		await showWords();
		const note = text(PHRASE_NOTE).element();
		await expect.poll(() => document.activeElement).toBe(note);

		await userEvent.click(button(CARD_LABELS.hide));
		expect(phrase().query()).toBeNull();
		for (const word of WORDS) expect(document.body.textContent).not.toContain(word);
		await expect.poll(() => document.activeElement).toBe(button(CARD_LABELS.show).element());

		await userEvent.click(button(CARD_LABELS.show));
		expect(shownWords()).toEqual(WORDS);
		await expect.poll(() => document.activeElement).toBe(text(PHRASE_NOTE).element());
	});

	// Hide hands focus to Show during the press; a repeat of the held key would land on Show and bring the words back.
	it('stay hidden for a held Enter on Hide words', async () => {
		await mount();
		await userEvent.click(toggle(CARD_LABELS.make, false));
		await showWords();
		button(CARD_LABELS.hide).element().focus();
		await holdEnter();
		expect(phrase().query()).toBeNull();
		await expect.element(button(CARD_LABELS.show)).toBeVisible();
	});

	it('stay on the page with no timer: half an hour with nobody touching it', async () => {
		await mount();
		await userEvent.click(toggle(CARD_LABELS.make, false));
		// Installed before the words appear, so a timer started by showing them would be the fake one.
		vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
		await showWords();
		vi.advanceTimersByTime(30 * 60_000);
		vi.useRealTimers();
		await expect.element(phrase()).toBeVisible();
	});
});

// ---- leaving the app -----------------------------------------------------------------------------------------------------

describe('leaving the app with the words on screen', () => {
	// Focus moving to a password manager's window or a same-page frame is not the person leaving.
	it('a window blur keeps the words and the type-back form on screen, and so does focus moving into a frame', async () => {
		const card = await mount();
		await typedBack(card);
		window.dispatchEvent(new Event('blur'));
		const frame = document.body.appendChild(document.createElement('iframe'));
		try {
			frame.contentWindow?.focus();
			await pause(30);
			await expect.element(phrase()).toBeVisible();
			await expect.element(field()).toBeVisible();
			expect(card.session.concealed).toBe(false);
		} finally {
			frame.remove();
		}
	});

	// The system takes its picture right after the page hides: the screen must have changed in the same task.
	it('a lifecycle hide takes the words off the page before it returns and hides every form', async () => {
		const card = await mount();
		await typedBack(card);
		const form = formOf(CARD_LABELS.make).element() as HTMLFormElement;
		expect(getComputedStyle(form).display).not.toBe('none');

		card.relock('hygiene');

		expect(phrase().query()).toBeNull();
		for (const word of WORDS) expect(document.body.textContent).not.toContain(word);
		expect(document.body.textContent).toContain(HIDDEN_WHILE_AWAY_LINE);
		expect(getComputedStyle(form).display).toBe('none');
	});

	// Restore and Check hold a passphrase field and the chooser too: away from the app, none of them may show.
	it.each<['restore' | 'check', string]>([
		['restore', CARD_LABELS.restore],
		['check', CARD_LABELS.check]
	])('a lifecycle hide gives the %s chooser and form computed display none', async (row, name) => {
		const card = await mount();
		card.choose(backupFile());
		await userEvent.click(toggle(name, false));
		const chooseEl = button(CARD_LABELS.chooseFile).element();
		expect(getComputedStyle(chooseEl).display).not.toBe('none');

		card.relock('hygiene');
		expect(getComputedStyle(chooseEl).display).toBe('none');
		await card.session.refresh();

		await userEvent.click(button(CARD_LABELS.chooseFile));
		await expect.element(field()).toBeVisible();
		const form = formOf(name).element();
		expect(getComputedStyle(form).display).not.toBe('none');
		card.relock('hygiene');
		expect(getComputedStyle(form).display).toBe('none');
		expect(card.session.kind).toBe(row);
	});

	it('the fields keep their element and their text through a hide, a fill while away, and the way back', async () => {
		const card = await mount();
		await typedBack(card, 'bamboo copper');
		const before = fieldEl();
		card.relock('hygiene');
		expect(before.isConnected).toBe(true);
		// A password manager's fill lands while the page is away.
		before.value = TYPED;
		before.dispatchEvent(new Event('input', { bubbles: true }));
		await card.session.refresh();
		await expect.element(phrase()).toBeVisible();
		expect(fieldEl()).toBe(before);
		expect(before.value).toBe(TYPED);
	});

	it.each([
		['shown before', true],
		['hidden by the person before', false]
	])('coming back shows the words only if they were %s', async (_name, shown) => {
		const card = await mount();
		await typedBack(card);
		if (!shown) await userEvent.click(button(CARD_LABELS.hide));
		card.relock('hygiene');
		expect(phrase().query()).toBeNull();
		await card.session.refresh();
		if (shown) await expect.element(phrase()).toBeVisible();
		else {
			expect(phrase().query()).toBeNull();
			await expect.element(button(CARD_LABELS.show)).toBeVisible();
		}
		expect(document.body.textContent).not.toContain(HIDDEN_WHILE_AWAY_LINE);
	});

	it('a Lock clears the words and the typed text, shuts the row and says the app locked', async () => {
		const card = await mount();
		await typedBack(card);
		const typed = fieldEl();
		card.relock('user');
		expect(typed.value).toBe('');
		await expect.poll(() => phrase().query()).toBeNull();
		await expect.element(toggle(CARD_LABELS.make, false)).toBeVisible();
		await expect.element(text(lockedLine())).toBeVisible();
		expect(card.session.words).toBeNull();
	});

	// Leaving the page ends the session; an app switch that swaps the card out keeps it.
	it.each<[string, string, 'none' | 'hidden' | 'locked']>([
		['a real move to another page', 'idle', 'none'],
		['the card swapped out while the app is hidden', 'phrase-shown', 'hidden'],
		// Another tab idling locks this profile and takes the card off the page; the person is still here to unlock.
		['the card taken off behind a lock that left the session alone', 'phrase-shown', 'locked']
	])('unmounting for %s leaves the session in %s', async (_name, phase, how) => {
		const card = await mount();
		await typedBack(card);
		if (how === 'hidden') card.relock('hygiene');
		if (how === 'locked') profile.relockSync('peer');
		await card.unmount();
		expect(card.session.phase).toBe(phase);
	});

	it('adds no window or document blur, focus or visibilitychange listener', async () => {
		const added: string[] = [];
		for (const target of [window, document]) {
			const original = target.addEventListener.bind(target);
			vi.spyOn(target, 'addEventListener').mockImplementation(((
				type: string,
				...rest: unknown[]
			) => {
				added.push(type);
				return (original as (...a: unknown[]) => void)(type, ...rest);
			}) as typeof target.addEventListener);
		}
		const card = await mount();
		await typedBack(card);
		card.relock('hygiene');
		await card.session.refresh();
		expect(added.filter((t) => ['blur', 'focus', 'visibilitychange'].includes(t))).toEqual([]);
	});
});

function lockedLine(): string {
	return need(backupMessage('E_LOCKED', { path: 'export' }));
}

// ---- Make a backup: typing back and saving -----------------------------------------------------------------------------

describe('typing the words back', () => {
	it('names what the type-back is for and files the label for the password manager', async () => {
		const card = await mount();
		await typedBack(card);
		await expect.element(text(TYPE_BACK_LINE)).toBeVisible();
		const name = page
			.getByLabelText(CARD_LABELS.backupName, { exact: true })
			.element() as HTMLInputElement;
		expect(name.readOnly).toBe(true);
		expect(name.getAttribute('autocomplete')).toBe('username');
		expect(name.value).toBe(card.session.names?.label);
		expect(fieldEl().type).toBe('password');
		expect(fieldEl().getAttribute('autocomplete')).toBe('new-password');
		expect(fieldEl().hasAttribute('maxlength')).toBe(false);
	});

	it('a wrong word is named by its place, opens no picker, and keeps the text and the focus', async () => {
		const card = await mount();
		await typedBack(card, WRONG);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect.element(text('Word 6 does not match the passphrase shown above.')).toBeVisible();
		expect(card.getSavePicker).not.toHaveBeenCalled();
		expect(fieldEl().value).toBe(WRONG);
		await expect.poll(() => document.activeElement).toBe(fieldEl());
	});

	// The browser opens its save dialog only for the tap that is still going on: an await before the call loses it.
	it('the save picker is called inside the submit itself', async () => {
		const card = await mount();
		await typedBack(card);
		(formOf(CARD_LABELS.make).element() as HTMLFormElement).requestSubmit();
		expect(card.getSavePicker).toHaveBeenCalledTimes(1);
		await expect.element(text(savedLine('picked.json'))).toBeVisible();
	});

	// A cancelled picker returns to the form; a held Enter would otherwise open it again and again.
	it.each(TIMINGS)(
		'a held Enter on the type-back asks for the save place once (picker backs out after %i ms)',
		async (ms) => {
			const card = await mount({
				picker: pickerOf({ after: ms, error: userCancel() }, userCancel(), userCancel())
			});
			await typedBack(card);
			fieldEl().focus();
			await holdEnter();
			await pause(100);
			expect(card.getSavePicker).toHaveBeenCalledTimes(1);
			await expect.element(submitOf(CARD_LABELS.make)).toBeVisible();
			expect(card.session.phase).toBe('typed-back');
		}
	);
});

describe('the backup and what the person is told', () => {
	it('saves, says where, reads it back, keeps the newest and updates Last backup', async () => {
		const file = fakeFile({ name: 'my-backup.json' });
		const card = await mount({ file });
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));

		await expect.element(text(savedLine('my-backup.json'))).toBeVisible();
		expect(file.closes).toBe(1);
		expect(document.body.textContent).toContain('Keep the newest. Delete older files.');
		await expect.element(button(CARD_LABELS.checkNow)).toBeVisible();
		await expect.element(text(lastBackupLine(formatBackupDate(Date.now())))).toBeVisible();
		// The words and the typed text are gone: the file is made.
		expect(phrase().query()).toBeNull();
		expect(card.session.words).toBeNull();
		await expect.poll(() => document.activeElement?.textContent).toBe(savedLine('my-backup.json'));
	});

	it('on a browser with no save picker, says the file was downloaded', async () => {
		const card = await mount({ picker: null });
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect.poll(() => card.download.mock.calls.length).toBe(1);
		const [fileName] = need(card.download.mock.calls[0]);
		await expect.element(text(downloadedLine(fileName))).toBeVisible();
		expect(fileName).toMatch(/^ask214-backup-\d{4}-\d{2}-\d{2}-[A-Z2-7]{4}\.json$/);
	});

	it('Check this backup now opens Check with an empty field and the words gone', async () => {
		const card = await mount();
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await userEvent.click(button(CARD_LABELS.checkNow));

		await expect.element(toggle(CARD_LABELS.check, true)).toBeVisible();
		await expect.element(button(CARD_LABELS.chooseFile)).toBeVisible();
		expect(card.session.kind).toBe('check');
		expect(card.session.words).toBeNull();
		expect(document.body.textContent).not.toContain(need(WORDS[0]));
		expect(text(savedLine('picked.json')).query()).toBeNull();
	});

	it('warns before replacing a file that holds something, and Replace it saves over it', async () => {
		const file = fakeFile({ existing: 'an older backup', name: 'old.json' });
		const card = await mount({ file });
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));

		await expect.element(button(CARD_LABELS.replaceIt)).toBeVisible();
		await expect.element(button(CARD_LABELS.chooseAnother)).toBeVisible();
		expect(document.body.textContent).toContain('old.json');
		expect(file.closes).toBe(0);
		await userEvent.click(button(CARD_LABELS.replaceIt));
		await expect.element(text(savedLine('old.json'))).toBeVisible();
		expect(card.session.phase).toBe('idle');
	});

	it('Choose another place opens a fresh picker from that tap and saves where the person points', async () => {
		const first = fakeFile({ existing: 'an older backup', name: 'old.json' });
		const second = fakeFile({ name: 'new.json' });
		const card = await mount({ file: first, picker: pickerOf(first.handle, second.handle) });
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await userEvent.click(button(CARD_LABELS.chooseAnother));

		await expect.element(text(savedLine('new.json'))).toBeVisible();
		expect(first.closes).toBe(0);
		expect(second.closes).toBe(1);
	});

	it.each<['mismatch' | 'not-checked', (name: string) => string]>([
		[
			'mismatch',
			(name) =>
				'Saved as ' +
				name +
				', but the saved file does not match, so it may not open. Make a new backup to another place. You can delete ' +
				name +
				'.'
		],
		['not-checked', notCheckedLine]
	])('a saved file that %s says so, without claiming it matches', async (kind, line) => {
		const file = fakeFile({ name: 'odd.json' });
		if (kind === 'mismatch') file.mangle = true;
		else file.readBack = 'reject';
		const card = await mount({ file });
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect.element(text(line('odd.json'))).toBeVisible();
		expect(text(savedLine('odd.json')).query()).toBeNull();
		if (kind === 'mismatch') {
			await userEvent.click(button(CARD_LABELS.makeAgain));
			await expect.element(button(CARD_LABELS.show)).toBeVisible();
			expect(card.session.kind).toBe('export');
		}
	});

	it('a close that fails says nothing was saved', async () => {
		const file = fakeFile();
		file.failClose = true;
		const card = await mount({ file });
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect
			.element(text('The backup was not saved. Try again, or choose another place.'))
			.toBeVisible();
		expect(card.session.phase).toBe('idle');
	});

	it('Cancel leaves the page once the file is being closed', async () => {
		const file = fakeFile();
		file.closeGate = deferred<void>();
		const card = await mount({ file });
		await typedBack(card);
		await expect.element(button(CARD_LABELS.cancel)).toBeVisible();
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect.poll(() => file.closes).toBe(1);
		expect(button(CARD_LABELS.cancel).query()).toBeNull();
		file.closeGate.resolve();
		await expect.element(text(savedLine('picked.json'))).toBeVisible();
	});

	it('a device whose setup is not finished is told to finish it', async () => {
		await profile.save({ setupIntent: 'pending' });
		const card = await mount();
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect.element(text(FINISH_SETUP_LINE)).toBeVisible();
		expect(card.session.phase).toBe('typed-back');
	});
});

// ---- a card brought back over a session that kept running ------------------------------------------------------------------

// Another tab idling locks this profile and takes the card off the page; the session is kept, and Unlock brings the card
// back. The new card must pick up where the old one was, not start from a blank flow.
describe('a card brought back after the profile locked behind it', () => {
	it('shows the same wrong-passphrase state, with its offer, and starts nothing', async () => {
		const card = await mount();
		await fileChosen(card, 'check');
		await field().fill(WRONG);
		await userEvent.click(submitOf(CARD_LABELS.check, CARD_LABELS.checkSubmit));
		await expect.element(button(MAKE_NEW_BACKUP_BUTTON)).toBeVisible();
		const before = card.workers.length;

		profile.relockSync('peer');
		await card.unmount();
		expect(card.session.kind).toBe('check');
		await card.remount();

		await expect.element(toggle(CARD_LABELS.check, true)).toBeVisible();
		await expect.element(text(wrongLine())).toBeVisible();
		await expect.element(button(MAKE_NEW_BACKUP_BUTTON)).toBeVisible();
		await expect.element(field()).toBeVisible();
		expect(card.workers.length).toBe(before);
	});

	it('still holds the replace warning the old card was showing', async () => {
		const file = fakeFile({ existing: 'an older backup', name: 'old.json' });
		const card = await mount({ file });
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect.element(button(CARD_LABELS.replaceIt)).toBeVisible();

		profile.relockSync('peer');
		await card.unmount();
		await card.remount();

		await expect.element(button(CARD_LABELS.replaceIt)).toBeVisible();
		expect(document.body.textContent).toContain('old.json');
		await userEvent.click(button(CARD_LABELS.replaceIt));
		await expect.element(text(savedLine('old.json'))).toBeVisible();
		expect(file.closes).toBe(1);
	});
});

describe('a card brought back after the person left the page', () => {
	// The saved line is for a card that was only taken off behind a lock. A person who went to another page and came back
	// starts from a closed row, and the sealed text is not held for a card that is no longer there.
	it('does not show the last result, nor offer to send the file', async () => {
		stubShare({ canShare: () => true, share: () => Promise.resolve() });
		const card = await mount();
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect.element(text(savedLine('picked.json'))).toBeVisible();

		await card.unmount();
		await card.remount();

		await expect.element(toggle(CARD_LABELS.make, false)).toBeVisible();
		expect(text(savedLine('picked.json')).query()).toBeNull();
		expect(button(CARD_LABELS.send).query()).toBeNull();
	});
});

// ---- where the cursor goes when the pressed button goes away ---------------------------------------------------------------------

// A button that is pressed and then leaves the page drops focus to the top of the page: a keyboard or screen-reader
// person would start again from the page's first control. It goes to the row's own toggle instead.
describe('focus when the pressed button leaves the page', () => {
	it.each<[string]>([[CARD_LABELS.make], [CARD_LABELS.restore], [CARD_LABELS.check]])(
		'Cancel on the %s row puts focus on that row (closed)',
		async (name) => {
			await mount();
			await userEvent.click(toggle(name, false));
			await userEvent.click(button(CARD_LABELS.cancel));

			await expect.element(toggle(name, false)).toBeVisible();
			await expect.poll(() => document.activeElement).toBe(toggle(name, false).element());
		}
	);

	it('Check this backup now puts focus on the Check row', async () => {
		const card = await mount();
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await userEvent.click(button(CARD_LABELS.checkNow));

		await expect.poll(() => document.activeElement).toBe(toggle(CARD_LABELS.check, true).element());
	});

	it('Make a new backup (after a file that does not match) puts focus on the Make row', async () => {
		const file = fakeFile();
		file.mangle = true;
		const card = await mount({ file });
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await userEvent.click(button(CARD_LABELS.makeAgain));

		await expect.poll(() => document.activeElement).toBe(toggle(CARD_LABELS.make, true).element());
	});

	it('Make a new backup now (after a wrong passphrase on Check) puts focus on the Make row', async () => {
		const card = await mount();
		await fileChosen(card, 'check');
		await field().fill(WRONG);
		await userEvent.click(submitOf(CARD_LABELS.check, CARD_LABELS.checkSubmit));
		await userEvent.click(button(MAKE_NEW_BACKUP_BUTTON));

		await expect.poll(() => document.activeElement).toBe(toggle(CARD_LABELS.make, true).element());
	});
});

// ---- Send a copy ------------------------------------------------------------------------------------------------------------

const shareUndo: (() => void)[] = [];

/** Stands in for the browser's share seam on this page: a missing function is `undefined`. */
function stubShare(o: {
	canShare: ((data: ShareData) => boolean) | undefined;
	share?: (data: ShareData) => Promise<void>;
}): void {
	for (const [name, value] of [
		['canShare', o.canShare],
		['share', o.share]
	] as const) {
		Object.defineProperty(navigator, name, { configurable: true, value });
		shareUndo.push(() => void Reflect.deleteProperty(navigator, name));
	}
}

afterEach(() => {
	for (const undo of shareUndo.splice(0)) undo();
});

describe('sending a copy', () => {
	const SEND = CARD_LABELS.send;

	// The offer is for a file that is known to be good, and only where the browser would accept that very file.
	it.each<[string, Mount, string]>([
		['the read-back matches', {}, 'my-backup.json'],
		['the file was downloaded', { picker: null }, '']
	])('shares the saved file itself when %s', async (_name, opts, savedName) => {
		const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
		stubShare({ canShare: () => true, share });
		const file = fakeFile({ name: 'my-backup.json' });
		const card = await mount({ file, ...opts });
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect.element(button(CARD_LABELS.checkNow)).toBeVisible();
		await userEvent.click(button(SEND));

		expect(share).toHaveBeenCalledOnce();
		const files = need(share.mock.calls[0])[0].files ?? [];
		expect(files).toHaveLength(1);
		const sent = need(files[0]);
		const expectedText = savedName === '' ? need(card.download.mock.calls[0])[1] : file.content;
		expect(await sent.text()).toBe(expectedText);
		expect(sent.name).toBe(savedName === '' ? need(card.download.mock.calls[0])[0] : savedName);
		expect(sent.type).toBe('application/json');
		// The file the browser was asked about is the one it was given.
		expect(sent.size).toBe(new TextEncoder().encode(expectedText).length);
	});

	it.each<[string, ((data: ShareData) => boolean) | undefined]>([
		['the browser has no canShare', undefined],
		['the browser would refuse the file', () => false]
	])('is not offered when %s', async (_name, canShare) => {
		stubShare({ canShare, share: () => Promise.resolve() });
		const card = await mount();
		await typedBack(card);
		await userEvent.click(submitOf(CARD_LABELS.make));
		await expect.element(button(CARD_LABELS.checkNow)).toBeVisible();
		expect(button(SEND).query()).toBeNull();
	});

	// A file that did not read back, or was not checked, is not one to pass on.
	it.each<['mismatch' | 'not-checked']>([['mismatch'], ['not-checked']])(
		'is not offered on the %s line',
		async (kind) => {
			stubShare({ canShare: () => true, share: () => Promise.resolve() });
			const file = fakeFile();
			if (kind === 'mismatch') file.mangle = true;
			else file.readBack = 'reject';
			const card = await mount({ file });
			await typedBack(card);
			await userEvent.click(submitOf(CARD_LABELS.make));
			await expect.element(text('Keep the newest. Delete older files.')).toBeVisible();
			expect(button(SEND).query()).toBeNull();
		}
	);

	it('a share the person backs out of says nothing', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);
		window.addEventListener('unhandledrejection', onUnhandled);
		try {
			stubShare({
				canShare: () => true,
				share: () => Promise.reject(new DOMException('Share canceled', 'AbortError'))
			});
			const card = await mount();
			await typedBack(card);
			await userEvent.click(submitOf(CARD_LABELS.make));
			await userEvent.click(button(SEND));
			await pause(50);
			expect(page.getByRole('alert').query()).toBeNull();
			await expect.element(button(SEND)).toBeVisible();
			expect(unhandled).toEqual([]);
		} finally {
			window.removeEventListener('unhandledrejection', onUnhandled);
		}
	});

	// The sealed text is kept only while the result line is on screen.
	it.each(['the row is closed', 'a Check is started from the result'])(
		'the offer and the text are gone when %s',
		async (how) => {
			const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
			stubShare({ canShare: () => true, share });
			const card = await mount();
			await typedBack(card);
			await userEvent.click(submitOf(CARD_LABELS.make));
			await expect.element(button(SEND)).toBeVisible();

			if (how === 'the row is closed') await userEvent.click(toggle(CARD_LABELS.make, true));
			else await userEvent.click(button(CARD_LABELS.checkNow));

			expect(button(SEND).query()).toBeNull();
			expect(share).not.toHaveBeenCalled();
			expect(card.session.kind).toBe(how === 'the row is closed' ? null : 'check');
		}
	);
});

// ---- Restore and Check ------------------------------------------------------------------------------------------------------

describe('getting ready', () => {
	// The key worker comes from the service worker's cache: no row may start key work before the page is controlled.
	it.each<[string, string, boolean]>([
		['Restore', CARD_LABELS.restore, true],
		['Check', CARD_LABELS.check, false]
	])(
		'%s shows Getting ready and no Choose file until the wait ends (controlled: %s)',
		async (_k, row, controlled) => {
			const wait = deferred<boolean>();
			const card = await mount({ wait: () => wait.promise });
			await userEvent.click(toggle(row, false));
			await expect.element(text(GETTING_READY_LINE)).toBeVisible();
			expect(button(CARD_LABELS.chooseFile).query()).toBeNull();
			expect(card.workers).toHaveLength(0);

			wait.resolve(controlled);
			await expect.element(button(CARD_LABELS.chooseFile)).toBeVisible();
			expect(text(GETTING_READY_LINE).query()).toBeNull();
			expect(card.workers).toHaveLength(0);
		}
	);
});

describe('choosing the file', () => {
	// The picker hides the page. The row must still be there, with the file, when the person comes back.
	it.each<['api' | 'input']>([['api'], ['input']])(
		'a hide between Choose file and the file arriving still reaches the words field (%s chooser)',
		async (chooser) => {
			// The headless browser dismisses a real file dialog at once, which would fire the input's cancel.
			if (chooser === 'input') {
				vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
			}
			const card = await mount({ chooser });
			await userEvent.click(toggle(CARD_LABELS.restore, false));
			const release = card.holdPicker();
			await userEvent.click(button(CARD_LABELS.chooseFile));
			card.relock('hygiene');
			if (chooser === 'api') {
				// The picker was opened by the tap; it answers after the hide.
				expect(card.openPicker).toHaveBeenCalledOnce();
				card.choose(backupFile());
				release();
			} else {
				const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
				expect(input?.parentElement).toBe(document.body);
				const transfer = new DataTransfer();
				transfer.items.add(backupFile());
				if (input !== null) input.files = transfer.files;
				input?.dispatchEvent(new Event('change'));
			}
			await card.session.refresh();
			await expect.element(field()).toBeVisible();
			expect(card.session.phase).toBe('file-chosen');
		}
	);

	// Pick the file first, then say the words: the box is not there until a file is chosen. After that "Choose file"
	// stays, because the file may be the wrong one.
	it.each<['restore' | 'check', string, string]>([
		['restore', CARD_LABELS.restore, CARD_LABELS.restoreSubmit],
		['check', CARD_LABELS.check, CARD_LABELS.checkSubmit]
	])(
		'the %s row asks for the passphrase only after a file is chosen',
		async (_row, name, submit) => {
			const card = await mount();
			card.choose(backupFile());
			await userEvent.click(toggle(name, false));

			await expect.element(button(CARD_LABELS.chooseFile)).toBeVisible();
			await expect.element(button(CARD_LABELS.cancel)).toBeVisible();
			expect(field().query()).toBeNull();
			expect(formOf(name).query()).toBeNull();
			expect(button(submit).query()).toBeNull();

			await userEvent.click(button(CARD_LABELS.chooseFile));

			await expect.element(field()).toBeVisible();
			await expect.element(submitOf(name, submit)).toBeVisible();
			await expect.element(button(CARD_LABELS.chooseFile)).toBeVisible();
			// The cursor goes to the box that just appeared.
			await expect.poll(() => document.activeElement).toBe(fieldEl());
		}
	);

	// The first pick may be the wrong file: choosing again must leave the second file in force, not the first.
	it('choosing another file replaces the first', async () => {
		const card = await mount();
		const nameField = () =>
			page.getByLabelText(CARD_LABELS.backupName, { exact: true }).element() as HTMLInputElement;
		card.choose(backupFile());
		await userEvent.click(toggle(CARD_LABELS.restore, false));
		await userEvent.click(button(CARD_LABELS.chooseFile));
		await expect.element(field()).toBeVisible();
		expect(nameField().value).toBe('Ask 214 backup 2026-10-15 K7Q2');

		card.choose(backupFile('ask214-backup-2026-10-14-ABCD.json'));
		await userEvent.click(button(CARD_LABELS.chooseFile));
		await expect.poll(() => nameField().value).toBe('Ask 214 backup 2026-10-14 ABCD');
		expect(card.session.phase).toBe('file-chosen');
		await expect.poll(() => document.activeElement).toBe(fieldEl());

		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		const dialog = page.getByRole('dialog');
		await expect.element(dialog).toBeVisible();
		expect(dialog.element().textContent).toContain('Ask 214 backup 2026-10-14 ABCD');
		expect(dialog.element().textContent).not.toContain('K7Q2');
	});

	it('backing out of the restore confirm leaves the file chosen: the box and Choose file both stay', async () => {
		const card = await mount();
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		await expect.element(page.getByRole('dialog')).toBeVisible();

		await userEvent.click(button(CARD_LABELS.cancel));

		await expect.poll(() => card.session.phase).toBe('file-chosen');
		await expect.element(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit)).toBeVisible();
		expect(fieldEl().value).toBe(TYPED);
		await expect.element(button(CARD_LABELS.chooseFile)).toBeVisible();
	});
});

describe('a wrong passphrase on a file', () => {
	// A screen-reader person on the field must hear why it is wrong, as they do on the type-back field.
	it.each<['restore' | 'check', string, string]>([
		['restore', CARD_LABELS.restore, CARD_LABELS.restoreSubmit],
		['check', CARD_LABELS.check, CARD_LABELS.checkSubmit]
	])('is tied to the %s field as its error', async (row, name, submit) => {
		const card = await mount();
		await fileChosen(card, row);
		expect(fieldEl().getAttribute('aria-invalid')).toBe('false');
		expect(fieldEl().hasAttribute('aria-describedby')).toBe(false);

		await field().fill(WRONG);
		await userEvent.click(submitOf(name, submit));
		await expect.element(text(wrongLine())).toBeVisible();

		expect(fieldEl().getAttribute('aria-invalid')).toBe('true');
		const described = document.getElementById(fieldEl().getAttribute('aria-describedby') ?? '');
		expect(described?.textContent).toBe(wrongLine());
	});
});

describe('restoring', () => {
	it('opens the confirm with Cancel focused, in a dialog the translator leaves alone', async () => {
		const card = await mount();
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));

		const dialog = page.getByRole('dialog');
		await expect.element(dialog).toBeVisible();
		expect(dialog.element().getAttribute('translate')).toBe('no');
		await expect.poll(() => document.activeElement).toBe(button(CARD_LABELS.cancel).element());
	});

	// A screen reader announces a dialog with its name and its description: what the device holds, and the warning that
	// restoring replaces newer changes, are what the person must hear before Replace.
	it('the confirm is described by the device line, the newer-changes warning and the reason it was read again', async () => {
		const card = await mount();
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		const dialog = page.getByRole('dialog');
		await expect.element(dialog).toBeVisible();

		const ids = (dialog.element().getAttribute('aria-describedby') ?? '').split(' ');
		const described = ids.map((id) => document.getElementById(id)?.textContent ?? null);
		expect(described).toHaveLength(2);
		expect(described[0]).toContain('This device was last changed');
		expect(described[1]).toBe(DEVICE_NEWER_WARNING);

		// The device moves while the person decides: Replace reads the details again, and says why, in the dialog.
		await profile.save({ skillbridgeStart: new TextEncoder().encode('2027-01-10') });
		await userEvent.click(button(CARD_LABELS.replace));
		const why = need(backupMessage('E_RESTORE_DEVICE_MOVED', { path: 'restore' }));
		await expect.element(dialog.getByText(why, { exact: true })).toBeVisible();
		const after = (dialog.element().getAttribute('aria-describedby') ?? '').split(' ');
		expect(after).toHaveLength(3);
		expect(document.getElementById(need(after[2]))?.textContent).toBe(why);
	});

	it('the confirm says what the backup holds, what the device holds, and what no backup carries', async () => {
		const card = await mount();
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));

		const dialog = page.getByRole('dialog');
		await expect.element(dialog).toBeVisible();
		const body = dialog.element().textContent ?? '';
		expect(body).toContain('Made on ' + formatBackupDate(FILE_MADE_AT));
		expect(body).toContain('Ask 214 backup 2026-10-15 K7Q2');
		expect(body).toContain('separation date set');
		expect(body).toContain('tasks with progress or a note');
		// This device has saved changes made after the backup was taken.
		expect(body).toContain('This device was last changed');
		expect(body).toContain(DEVICE_NEWER_WARNING);
		expect(body).toContain(ONLY_RESTORE_YOURS_LINE);
		expect(body).toContain(NOT_IN_BACKUPS_LEAD);
		for (const item of NOT_IN_BACKUPS) expect(body).toContain(item);
		expect(card.reload).not.toHaveBeenCalled();
	});

	// Cancel is a way back to the words, not an end of the restore: nothing was written and the text is kept.
	it('Cancel in the confirm goes back to the field, with the text kept and the focus on it', async () => {
		const card = await mount();
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		await expect.element(page.getByRole('dialog')).toBeVisible();
		// The confirm holds the opened key and the details it was built from.
		expect(card.session.held('key')).toBeInstanceOf(CryptoKey);
		expect(card.session.held('confirm')).not.toBeNull();

		await userEvent.click(button(CARD_LABELS.cancel));

		expect(page.getByRole('dialog').query()).toBeNull();
		expect(card.session.phase).toBe('file-chosen');
		// Going back drops both: Restore opens the file with the words again.
		expect(card.session.held('key')).toBeNull();
		expect(card.session.held('confirm')).toBeNull();
		expect(fieldEl().value).toBe(TYPED);
		await expect.poll(() => document.activeElement).toBe(fieldEl());
		expect(card.reload).not.toHaveBeenCalled();
		expect(card.published).toEqual([]);
	});

	// Escape is a way out of any dialog; here it must mean the same as Cancel, not leave the restore stuck on a
	// confirm nobody can see.
	it('Escape in the confirm goes back to the field like Cancel', async () => {
		const card = await mount();
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		await expect.element(page.getByRole('dialog')).toBeVisible();

		await userEvent.keyboard('{Escape}');

		await expect.poll(() => card.session.phase).toBe('file-chosen');
		expect(page.getByRole('dialog').query()).toBeNull();
		await expect.poll(() => document.activeElement).toBe(fieldEl());
	});

	it('leaving the app with the confirm open closes it, says so, and keeps the words', async () => {
		const card = await mount();
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		await expect.element(page.getByRole('dialog')).toBeVisible();

		card.relock('hygiene');
		await expect.poll(() => page.getByRole('dialog').query()).toBeNull();
		await card.session.refresh();

		await expect
			.element(text(need(backupMessage('E_LEFT_APP', { path: 'restore' }))))
			.toBeVisible();
		expect(fieldEl().value).toBe(TYPED);
		expect(card.reload).not.toHaveBeenCalled();
	});

	it('Replace writes the backup, tells the other tabs, and sends this page to the Timeline', async () => {
		const card = await mount();
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		await userEvent.click(button(CARD_LABELS.replace));

		await expect.poll(() => card.reload.mock.calls.length).toBe(1);
		expect(card.published).toEqual([{ type: 'data-replaced' }]);
	});

	it('a restore that was locked on the way says to unlock', async () => {
		const card = await mount();
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		// The person locks the app in the instant the write commits.
		const original = card.session.markCommitting;
		card.session.markCommitting = () => {
			original();
			card.relock('user');
		};
		await userEvent.click(button(CARD_LABELS.replace));
		await expect.element(text(RESTORED_UNLOCK_LINE)).toBeVisible();
	});

	// A wrong word order is the likeliest mistake: the person keeps the text, is told, and a held key must not retry.
	it.each(TIMINGS)(
		'a wrong passphrase keeps the field and asks once for a held Enter (derive takes %i ms)',
		async (ms) => {
			timing.ms = ms;
			const card = await mount();
			await fileChosen(card, 'restore');
			await field().fill(WRONG);
			const before = card.workers.length;
			fieldEl().focus();
			await holdEnter();
			await expect.element(text(wrongLine())).toBeVisible();
			await pause(100);
			expect(card.workers.length - before).toBe(1);
			expect(fieldEl().value).toBe(WRONG);
			await expect.poll(() => document.activeElement).toBe(fieldEl());
		}
	);

	// The confirm opens under the held key: the repeats land on Cancel and must not press it.
	it.each(TIMINGS)(
		'a held Enter on the restore field leaves the confirm open on Cancel (work takes %i ms)',
		async (ms) => {
			timing.ms = ms;
			const card = await mount();
			await fileChosen(card, 'restore');
			await field().fill(TYPED);
			const before = card.workers.length;
			fieldEl().focus();
			await holdEnter();
			await expect.element(page.getByRole('dialog')).toBeVisible();
			expect(card.workers.length - before).toBe(1);
			await expect.poll(() => document.activeElement).toBe(button(CARD_LABELS.cancel).element());
			expect(card.session.phase).toBe('confirm');
		}
	);

	// Cancel hands focus back to the field during the press: a repeat there must not ask for the confirm again.
	it.each(TIMINGS)(
		'a held Enter on Cancel does not Replace and does not open the confirm again (work takes %i ms)',
		async (ms) => {
			timing.ms = ms;
			const card = await mount();
			await fileChosen(card, 'restore');
			await field().fill(TYPED);
			await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
			await expect.element(page.getByRole('dialog')).toBeVisible();
			const before = card.workers.length;
			button(CARD_LABELS.cancel).element().focus();
			await holdEnter();
			await pause(150);
			expect(page.getByRole('dialog').query()).toBeNull();
			expect(card.session.phase).toBe('file-chosen');
			expect(card.workers.length - before).toBe(0);
			expect(card.reload).not.toHaveBeenCalled();
			await expect.poll(() => document.activeElement).toBe(fieldEl());
		}
	);

	it('Cancel while the device is being read says Stopping, then that nothing was changed', async () => {
		const read = deferred<{ state: DeviceState; installUuid: Uint8Array }>();
		const card = await mount({ readDevice: () => read.promise });
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		await expect.poll(() => card.session.phase).toBe('decrypting');

		await userEvent.click(button(CARD_LABELS.cancel));
		await expect.element(text(STOPPING_LINE)).toBeVisible();
		read.resolve(await realRead(db));
		await expect.element(text('Stopped. Nothing on this device was changed.')).toBeVisible();
		expect(text(STOPPING_LINE).query()).toBeNull();
		await expect.element(toggle(CARD_LABELS.restore, false)).toBeVisible();
	});

	// A code the wording does not cover yet still says the step stopped: a tap that ends in silence reads as broken.
	it('a stop with no wording of its own still says that the step stopped', async () => {
		const card = await mount({
			readDevice: () => Promise.reject(new KeystoreNotInitializedError())
		});
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		await expect
			.element(text(need(backupMessage('E_WORKER_FAILED', { path: 'restore' }))))
			.toBeVisible();
		expect(card.session.phase).toBe('file-chosen');
	});

	it('a damaged device offers to erase, and the host opens its own dialog', async () => {
		const card = await mount({
			readDevice: () => Promise.reject(new Error('E_RESTORE_DEVICE_DAMAGED'))
		});
		await fileChosen(card, 'restore');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.restore, CARD_LABELS.restoreSubmit));
		await userEvent.click(button(ERASE_DEVICE_BUTTON));
		expect(card.onEraseRequest).toHaveBeenCalledOnce();
	});
});

function wrongLine(): string {
	return need(
		backupMessage('E_WRONG_PASSPHRASE', {
			path: 'restore',
			label: 'Ask 214 backup 2026-10-15 K7Q2'
		})
	);
}

describe('checking', () => {
	it('says the backup opens and when it was made, and writes nothing', async () => {
		const card = await mount();
		await fileChosen(card, 'check');
		await field().fill(TYPED);
		await userEvent.click(submitOf(CARD_LABELS.check, CARD_LABELS.checkSubmit));
		const line = checkOpensLine(formatBackupDate(FILE_MADE_AT));
		await expect.element(text(line)).toBeVisible();
		await expect.poll(() => document.activeElement?.textContent).toBe(line);
		expect(card.published).toEqual([]);
		expect(page.getByRole('dialog').query()).toBeNull();
	});

	it.each(TIMINGS)(
		'a wrong passphrase keeps the field, checks once for a held Enter and offers a new backup (derive takes %i ms)',
		async (ms) => {
			timing.ms = ms;
			const card = await mount();
			await fileChosen(card, 'check');
			await field().fill(WRONG);
			const before = card.workers.length;
			fieldEl().focus();
			await holdEnter();
			await expect.element(text(wrongLine())).toBeVisible();
			await pause(100);
			expect(card.workers.length - before).toBe(1);
			expect(fieldEl().value).toBe(WRONG);
			await expect.element(text(CHECK_NEW_BACKUP_OFFER)).toBeVisible();
		}
	);

	it('Make a new backup now closes Check and opens Make a backup', async () => {
		const card = await mount();
		await fileChosen(card, 'check');
		await field().fill(WRONG);
		await userEvent.click(submitOf(CARD_LABELS.check, CARD_LABELS.checkSubmit));
		await userEvent.click(button(MAKE_NEW_BACKUP_BUTTON));
		await expect.element(toggle(CARD_LABELS.make, true)).toBeVisible();
		await expect.element(button(CARD_LABELS.show)).toBeVisible();
		expect(card.session.kind).toBe('export');
		expect(toggle(CARD_LABELS.check, true).query()).toBeNull();
	});
});
