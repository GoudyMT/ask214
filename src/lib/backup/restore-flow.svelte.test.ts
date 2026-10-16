import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { resolve } from '$app/paths';
import type { BusSignal } from '../broadcast/bus';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { reqToPromise, STORES, withStores, type StoreName } from '../db/schema';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { decodeEaos, encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { zeroizeRecord } from '../profile/lifecycle';
import {
	createProfileStore,
	OccConflictError,
	readDeviceState,
	readKeystoreRow,
	type DeviceState,
	type ProfileStore
} from '../profile/store.svelte';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { MAX_FILE_BYTES } from './caps';
import { BACKUP_RELEASE_DATE, formatBackupDate } from './dates';
import { newBackupSalt, decryptEnvelope, sealEnvelope } from './envelope';
import { buildExportInner } from './export-inner';
import { takeBackupIntent } from './intent';
import {
	DEVICE_NEWER_WARNING,
	DEVICE_NO_DATA_LINE,
	LOCKED_AFTER_RESTORE_LINE,
	NOT_IN_BACKUPS,
	RESTORED_RELOAD_LINE,
	RESTORED_UNLOCK_LINE,
	RestoreFlow,
	type FlowDeps
} from './restore-flow';
import { restoreBackup } from './restore-writer';
import { BackupSession, type OpenPicker, type WorkerLike } from './session.svelte';
import { takeSnapshot } from './snapshot';
import { validateInner } from './validate';
import { createHandler } from './worker/handler';
import type { FromWorker, WorkerRequest } from './worker/protocol';
import { WORDS_V1 } from './words-v1';

// The slow key step is the only thing replaced: a quick stand-in that gives every password and salt its own 32 bytes.
// The real worker handler runs around it, so the word check, the key derivation from those bytes and the key's use
// all run for real.
vi.mock('@noble/hashes/argon2.js', () => ({
	argon2id: (pass: Uint8Array, salt: Uint8Array) => {
		const out = new Uint8Array(32);
		let h = 0x811c9dc5;
		const mix = (byte: number): void => {
			h = Math.imul(h ^ byte, 0x01000193) >>> 0;
		};
		for (const byte of pass) mix(byte);
		for (const byte of salt) mix(byte);
		for (let i = 0; i < out.length; i += 1) {
			mix(i + 1);
			out[i] = h & 255;
		}
		return out;
	}
}));

// Passthrough spies, so a test can see what the flow asked of the real validator, the real decrypt and the real writer.
// `$lib` paths on purpose: with a relative path a mock never applied to the flow's own import in this browser runner.
vi.mock('$lib/backup/validate', async (importOriginal) => {
	const real = await importOriginal<typeof import('./validate')>();
	return { ...real, validateInner: vi.fn(real.validateInner) };
});
vi.mock('$lib/backup/envelope', async (importOriginal) => {
	const real = await importOriginal<typeof import('./envelope')>();
	return { ...real, decryptEnvelope: vi.fn(real.decryptEnvelope) };
});
vi.mock('$lib/backup/restore-writer', async (importOriginal) => {
	const real = await importOriginal<typeof import('./restore-writer')>();
	return { ...real, restoreBackup: vi.fn(real.restoreBackup) };
});

// ---- fakes and builders ------------------------------------------------------------------------------------------

type FlowKind = 'restore' | 'check';

const WORDS = ['bamboo', 'copper', 'harvest', 'lantern', 'oxygen', 'thimble'];
const PHRASE = WORDS.join(' ');
// Six other words from the list, so a wrong passphrase gets as far as opening the file.
const OTHER_WORDS = WORDS_V1.slice(100, 106);
const OUR_NAME = 'ask214-backup-2026-10-15-K7Q2.json';
const OUR_LABEL = 'Ask 214 backup 2026-10-15 K7Q2';
const MINUTE = 60_000;
const DAY = 86_400_000;
const START_URL = location.href;
const START_STATE: unknown = history.state;

function need<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error('test setup: value missing');
	return value;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolveIt!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolveIt = res;
	});
	return { promise, resolve: resolveIt };
}

/** The key worker with the real handler behind it, answering as a worker does: later, with the buffer detached. */
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

/** A worker that never answers, like one that was cut off mid-way. */
class SilentWorker implements WorkerLike {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessageerror: ((event: unknown) => void) | null = null;
	postMessage(): void {}
	terminate(): void {}
}

async function keyFor(
	purpose: 'export' | 'restore',
	words: readonly string[],
	salt: Uint8Array
): Promise<CryptoKey> {
	const pass = new TextEncoder().encode(words.join(' ')).buffer;
	let answer: FromWorker | undefined;
	const { handle } = createHandler(WORDS_V1, (message) => {
		if (message.type !== 'progress') answer = message;
	});
	await handle({ op: 'derive', purpose, pass, salt: Uint8Array.from(salt) });
	if (answer?.type !== 'key') throw new Error('E_TEST_NO_KEY');
	return answer.key;
}

const opened: IDBDatabase[] = [];
const profiles: ProfileStore[] = [];

async function newDb(): Promise<IDBDatabase> {
	const db = await openTestDb();
	opened.push(db);
	return db;
}

type Device = {
	db: IDBDatabase;
	profile: ProfileStore;
	timeline: ReturnType<typeof createTimelineStateStore>;
	calendar: ReturnType<typeof createCalendarSyncStore>;
};

/** A phone whose setup is finished and that holds a little of its own, built the way a person builds one. */
async function finishedDevice(db: IDBDatabase, eaos = '2028-02-01'): Promise<Device> {
	await bootstrapLocalKeystore(db);
	const profile = createProfileStore(db);
	profiles.push(profile);
	const date = encodeEaos(parseEaosAtRead(eaos));
	try {
		await profile.save({ setupIntent: 'completed', eaos: date });
	} finally {
		date.fill(0);
	}
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	await timeline.setStatus('sha-complete', 'done');
	await timeline.setNote('sha-complete', 'Call the TAP office');
	await timeline.setStatus('sha-schedule', 'skipped');
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	await calendar.setExclusions({ taskIds: ['sha-schedule'], categories: ['finance'] });
	return { db, profile, timeline, calendar };
}

/** A phone that was just set up: the keys exist, nothing is saved yet. */
async function newPhone(): Promise<{ db: IDBDatabase; store: ProfileStore }> {
	const db = await newDb();
	await bootstrapLocalKeystore(db);
	const store = createProfileStore(db);
	profiles.push(store);
	return { db, store };
}

type ExportOptions = {
	createdAt: number;
	words?: readonly string[];
	/** Writes the backup mark after the file is sealed, as the export flow does. */
	mark?: boolean;
	/** Runs between the snapshot and the mark write: another tab acting in the gap. */
	between?: () => Promise<void>;
};

/** A backup made the way the app makes one: the snapshot, the export check, the seal, then the mark. */
async function exportFrom(device: Device, o: ExportOptions, name = OUR_NAME): Promise<File> {
	const snap = await takeSnapshot(device.db);
	if (!snap.ok) throw new Error('E_TEST_SNAPSHOT');
	try {
		const built = buildExportInner(snap, o.createdAt);
		if (!built.ok) throw new Error('E_TEST_EXPORT');
		const salt = newBackupSalt();
		const key = await keyFor('export', o.words ?? WORDS, salt);
		let text: string;
		try {
			text = await sealEnvelope(key, built.bytes, salt);
		} finally {
			built.bytes.fill(0);
		}
		await o.between?.();
		if (o.mark !== false) {
			try {
				await device.profile.save({
					lastBackupAt: o.createdAt,
					backupGenProfile: snap.gens.profile + 1,
					backupGenTimeline: snap.gens.timeline,
					backupGenCalendar: snap.gens.calendar
				});
			} catch (e) {
				// Another tab got there first; the backup still stands, the device just carries no mark.
				if (!(e instanceof OccConflictError)) throw e;
			}
		}
		return new File([text], name);
	} finally {
		zeroizeRecord(snap.profile as unknown as Record<string, unknown>);
	}
}

// ---- rows ----------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const SEVEN: StoreName[] = STORES.filter((store) => store !== 'byok');
const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function plain(value: unknown): unknown {
	if (value instanceof Uint8Array) return `u8:${hex(value)}`;
	if (value instanceof ArrayBuffer) return `ab:${hex(new Uint8Array(value))}`;
	if (value instanceof CryptoKey) return 'CryptoKey';
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([key, inner]) => [key, plain(inner)])
		);
	}
	return value;
}

function readRaw(db: IDBDatabase, store: StoreName): Promise<Row | undefined> {
	return withStores(db, store, 'readonly', (tx) =>
		reqToPromise<Row | undefined>(tx.objectStore(store).get(0))
	);
}

/** The seven stores a restore writes, as the device holds them right now, bytes included. */
async function sevenRows(db: IDBDatabase): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const store of SEVEN) out[store] = plain(await readRaw(db, store));
	return out;
}

// ---- the rig ---------------------------------------------------------------------------------------------------------

type RigOptions = {
	db: IDBDatabase | null;
	store?: ProfileStore | null;
	status?: 'ready' | 'damaged';
	wait?: () => Promise<boolean>;
	readDevice?: NonNullable<FlowDeps['readDevice']>;
	worker?: () => WorkerLike;
	timelinePath?: () => string;
	visible?: boolean;
};

type Rig = {
	session: BackupSession;
	flow: RestoreFlow;
	app: FlowDeps['app'];
	published: BusSignal[];
	reload: Mock<() => void>;
	replace: Mock<(path: string) => void>;
	win: EventTarget;
	picker: Mock<OpenPicker>;
	field: { value: string };
	made: { workers: number };
	visible: { value: boolean };
	waiting: { fn: (() => void) | null };
	pick: (file: File | null) => void;
};

const rigs: Rig[] = [];

/** One tab's session and flow, with the window, the chooser, the page's visibility and the reload as fakes. */
function makeRig(o: RigOptions): Rig {
	const published: BusSignal[] = [];
	const reload = vi.fn<() => void>();
	const replace = vi.fn<(path: string) => void>();
	const win = new EventTarget();
	const chosen: { file: File | null } = { file: null };
	const picker = vi.fn<OpenPicker>(async () =>
		chosen.file === null ? [] : [{ getFile: async () => need(chosen.file) }]
	);
	const made = { workers: 0 };
	const visible = { value: o.visible ?? true };
	const waiting: { fn: (() => void) | null } = { fn: null };
	const session = new BackupSession({
		isVisible: () => visible.value,
		hasFocus: () => true,
		setTimer: () => 0,
		clearTimer: () => {},
		getWindow: () => win,
		createWorker: () => {
			made.workers += 1;
			return o.worker ? o.worker() : new HandlerWorker();
		},
		getOpenPicker: () => picker
	});
	const app: FlowDeps['app'] = {
		status: o.status ?? 'ready',
		joinRelock: () => () => {},
		publish: o.status === 'damaged' ? null : (signal) => void published.push(signal),
		store: o.store ?? null,
		reloadOnUnlock: false
	};
	const flow = new RestoreFlow({
		session,
		app,
		db: o.db,
		waitForControl: o.wait ?? (() => Promise.resolve(true)),
		...(o.readDevice && { readDevice: o.readDevice }),
		...(o.timelinePath && { timelinePath: o.timelinePath }),
		reload,
		replace,
		isVisible: () => visible.value,
		onceVisible: (fn) => {
			waiting.fn = fn;
			return () => {
				waiting.fn = null;
			};
		}
	});
	// The card's passphrase field: the session wipes it on a real stop, never on a failed attempt.
	const field = { value: '' };
	session.registerInput(field);
	const rig: Rig = {
		session,
		flow,
		app,
		published,
		reload,
		replace,
		win,
		picker,
		field,
		made,
		visible,
		waiting,
		pick: (file: File | null): void => {
			chosen.file = file;
		}
	};
	rigs.push(rig);
	return rig;
}

async function toFileChosen(r: Rig, file: File, kind: 'restore' | 'check' = 'restore') {
	await r.flow.open(kind);
	r.pick(file);
	await r.flow.chooseFile();
}

async function toConfirm(r: Rig, file: File, phrase = PHRASE): Promise<void> {
	await toFileChosen(r, file);
	r.field.value = phrase;
	await r.flow.submit(phrase);
}

/** A rig over a device whose rows the test will look at. */
function restoreRig(
	device: { db: IDBDatabase; store?: ProfileStore },
	extra: Partial<RigOptions> = {}
) {
	return makeRig({ db: device.db, store: device.store ?? null, ...extra });
}

async function realRead(db: IDBDatabase): Promise<{ state: DeviceState; installUuid: Uint8Array }> {
	const keystore = await readKeystoreRow(db);
	return { state: await readDeviceState(db), installUuid: new Uint8Array(keystore.installUuid) };
}

/** Runs `fn` inside the writer's synchronous point of no return, right after the session is marked committing. */
function duringCommit(r: Rig, fn: () => void): void {
	const original = r.session.markCommitting;
	r.session.markCommitting = () => {
		original();
		fn();
	};
}

// One backup file for the tests that only need some good file, made once on a throwaway device.
let FILE_TEXT = '';
let FILE_CREATED_AT = 0;

beforeAll(async () => {
	const db = await openTestDb();
	try {
		const device = await finishedDevice(db);
		FILE_CREATED_AT = Date.now() - 5 * MINUTE;
		FILE_TEXT = await (await exportFrom(device, { createdAt: FILE_CREATED_AT })).text();
		device.profile.relockSync('hygiene');
	} finally {
		await deleteTestDb(db);
	}
	profiles.length = 0;
}, 60_000);

const backupFile = (name = OUR_NAME): File => new File([FILE_TEXT], name);

beforeEach(() => {
	vi.mocked(validateInner).mockClear();
	vi.mocked(decryptEnvelope).mockClear();
	vi.mocked(restoreBackup).mockClear();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const r of rigs.splice(0)) r.session.end();
	for (const store of profiles.splice(0)) store.relockSync('hygiene');
	for (const db of opened.splice(0)) await deleteTestDb(db);
	history.replaceState(START_STATE, '', START_URL);
});

// ---- the row -------------------------------------------------------------------------------------------------------

describe('opening the row', () => {
	// The key worker comes from the service worker's cache, so a first visit must not start key work before it is there.
	it.each<[FlowKind, boolean]>([
		['restore', true],
		['check', false]
	])(
		'%s waits for the page to be controlled, then moves on (controlled: %s)',
		async (kind, controlled) => {
			const wait = deferred<boolean>();
			const db = kind === 'restore' ? await newDb() : null;
			const r = makeRig({ db, wait: () => wait.promise });
			const opening = r.flow.open(kind);
			await new Promise((done) => setTimeout(done, 0));
			expect(r.session.phase).toBe('getting-ready');
			expect(r.made.workers).toBe(0);
			wait.resolve(controlled);
			await opening;
			expect(r.session.phase).toBe('choose-file');
			expect(r.made.workers).toBe(0);
		}
	);

	// The person locked the app and opened a row again while the first wait was still out: the old wait must not move
	// the new row on.
	it('a wait that ends after the row was closed does not move the next row', async () => {
		const first = deferred<boolean>();
		const second = deferred<boolean>();
		const waits = [first, second];
		const r = makeRig({ db: null, wait: () => need(waits.shift()).promise });
		const a = r.flow.open('check');
		r.session.relockSync('user');
		const b = r.flow.open('check');
		first.resolve(true);
		await a;
		expect(r.session.phase).toBe('getting-ready');
		second.resolve(true);
		await b;
		expect(r.session.phase).toBe('choose-file');
	});
});

describe('choosing the file', () => {
	// The system chooser needs the click's own activation, and a renamed backup must still be choosable.
	it('opens the chooser in the same task as the click with no type filter, and a back-out changes nothing', async () => {
		const r = makeRig({ db: null });
		await r.flow.open('check');
		const choosing = r.flow.chooseFile();
		expect(r.picker).toHaveBeenCalledTimes(1);
		expect(r.picker).toHaveBeenCalledWith({ multiple: false, excludeAcceptAllOption: false });
		await choosing;
		expect(r.session.phase).toBe('choose-file');
		expect(r.session.busy).toBe(false);
		expect(r.session.message).toBeNull();
	});

	// A file that is not a backup is said so before any key work, and it replaces the earlier choice, so nothing from the
	// earlier file can be opened by mistake.
	class UnderstatingFile extends File {
		override get size(): number {
			return 10;
		}
	}
	// A file that is gone or unreadable by the time it is read (a cloud file that went offline) is a copy to replace.
	class UnreadableFile extends File {
		override slice(): Blob {
			return {
				arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError'))
			} as Blob;
		}
	}
	it.each<[string, () => File, string]>([
		[
			'a file that cannot be read',
			() => new UnreadableFile(['x'], 'cloud.json'),
			'damaged or was changed'
		],
		[
			'a file that is not a backup',
			() => new File(['hello'], 'notes.txt'),
			'is not an Ask 214 backup'
		],
		[
			'a file whose reported size understates its bytes',
			() => new UnderstatingFile([new Uint8Array(MAX_FILE_BYTES + 100)], 'big.json'),
			'too large'
		]
	])('%s is refused with its line and drops the earlier file', async (_name, make, fragment) => {
		const r = makeRig({ db: null });
		await toFileChosen(r, backupFile(), 'check');
		expect(r.flow.view.label).toBe(OUR_LABEL);
		r.pick(make());
		await r.flow.chooseFile();
		expect(r.session.phase).toBe('choose-file');
		expect(r.flow.view.line).toContain(fragment);
		expect(r.flow.view.label).toBeNull();
		expect(r.session.busy).toBe(false);
		await r.flow.submit(PHRASE);
		expect(r.made.workers).toBe(0);
		expect(r.session.phase).toBe('choose-file');
	});
});

// ---- the words -----------------------------------------------------------------------------------------------------

describe('typing the six words', () => {
	// A typo must cost the person nothing but the message: the field keeps its text, takes focus, and the next try works.
	it.each<[string, string, string, string]>([
		[
			'the words in the wrong order',
			[...WORDS].reverse().join(' '),
			'E_WRONG_PASSPHRASE',
			'do not open this backup'
		],
		[
			'a word that is not on the list',
			WORDS.map((w, i) => (i === 1 ? 'qqqqq' : w)).join(' '),
			'E_NOT_A_WORD',
			'Word 2 is not one of the backup words'
		],
		['five words', WORDS.slice(0, 5).join(' '), 'E_WORD_COUNT', 'Enter all 6 words'],
		[
			'a comma after a word',
			WORDS.map((w, i) => (i === 0 ? w + ',' : w)).join(' '),
			'E_NOT_LETTERS',
			'Word 1 has a character that is not a plain letter'
		]
	])(
		'%s keeps the typed text, names the problem and lets the next try open it',
		async (_name, typed, code, fragment) => {
			const phone = await newPhone();
			const r = restoreRig(phone);
			await toFileChosen(r, backupFile());
			r.field.value = typed;
			await r.flow.submit(typed);
			expect(r.session.phase).toBe('file-chosen');
			expect(r.session.message).toBe(code);
			expect(r.session.busy).toBe(false);
			expect(r.field.value).toBe(typed);
			expect(r.flow.view.focusField).toBe(1);
			expect(r.flow.view.line).toContain(fragment);
			// No word of the passphrase appears anywhere the card could read.
			for (const word of WORDS) expect(JSON.stringify(r.flow.view)).not.toContain(word);

			await r.flow.submit(PHRASE);
			expect(r.session.phase).toBe('confirm');
			expect(r.session.message).toBeNull();
		}
	);

	// The wrong-passphrase line points at the passphrase saved under this backup's name, but only when the name is the
	// one the app gave it; on Check it also offers a new backup while the phone still has the data.
	it.each<[string, FlowKind, string, boolean, boolean]>([
		['a file named as the app names it', 'restore', OUR_NAME, true, false],
		['a renamed file', 'check', 'my backup.json', false, true]
	])(
		'a wrong passphrase on %s (%s)',
		async (_name, kind, fileName, namesLabel, offersNewBackup) => {
			const phone = kind === 'restore' ? await newPhone() : null;
			const r = makeRig({ db: phone?.db ?? null });
			await toFileChosen(r, backupFile(fileName), kind);
			await r.flow.submit(OTHER_WORDS.join(' '));
			expect(r.session.message).toBe('E_WRONG_PASSPHRASE');
			const line = need(r.flow.view.line);
			expect(line.includes(OUR_LABEL)).toBe(namesLabel);
			expect(line).not.toContain('delete');
			expect(r.flow.view.offerNewBackup).toBe(offersNewBackup);
		}
	);

	// Leaving or locking is different from a typo: the words are wiped then, even after a failed try.
	it('a lock after a failed try still wipes the typed words', async () => {
		const phone = await newPhone();
		const r = restoreRig(phone);
		await toFileChosen(r, backupFile());
		r.field.value = OTHER_WORDS.join(' ');
		await r.flow.submit(r.field.value);
		expect(r.field.value).not.toBe('');
		r.session.relockSync('user');
		expect(r.field.value).toBe('');
		expect(r.session.phase).toBe('idle');
	});

	// Cancel mid-way must end in the stopped line, not hang on "Stopping".
	it('Cancel while the key is being made ends with the stopped line and nothing written', async () => {
		const phone = await newPhone();
		const before = await sevenRows(phone.db);
		const r = restoreRig(phone, { worker: () => new SilentWorker() });
		await toFileChosen(r, backupFile());
		r.field.value = PHRASE;
		const submitting = r.flow.submit(PHRASE);
		expect(r.session.phase).toBe('deriving');
		expect(r.session.cancel()).toBe(true);
		await submitting;
		expect(r.session.stopping).toBe(false);
		expect(r.session.message).toBe('E_RESTORE_CANCELLED');
		expect(r.field.value).toBe('');
		expect(await sevenRows(phone.db)).toStrictEqual(before);
	});
});

// ---- the confirm ---------------------------------------------------------------------------------------------------

describe('the confirm', () => {
	// The device is read once, after the file has been opened and checked. Until that read is back there is no confirm
	// and so nothing to press.
	it('does not render before the one read resolves, and shows what the backup holds', async () => {
		const phone = await newPhone();
		const gate = deferred<void>();
		const read = vi.fn(async (db: IDBDatabase) => {
			await gate.promise;
			return realRead(db);
		});
		const r = restoreRig(phone, { readDevice: read });
		await toFileChosen(r, backupFile());
		const submitting = r.flow.submit(PHRASE);
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
		expect(r.session.phase).toBe('decrypting');
		expect(r.flow.confirm).toBeNull();
		expect(r.flow.view.confirm).toBeNull();
		await r.flow.replace();
		expect(restoreBackup).not.toHaveBeenCalled();

		gate.resolve();
		await submitting;
		expect(read).toHaveBeenCalledTimes(1);
		expect(r.session.phase).toBe('confirm');
		const confirm = need(r.flow.confirm);
		expect(confirm.gens).toEqual({ profile: 0, timeline: 0, calendar: 0 });
		expect(confirm.summary).toEqual({
			madeOn: formatBackupDate(FILE_CREATED_AT),
			label: OUR_LABEL,
			tasks: 2,
			notes: 1,
			calendarExclusions: 2
		});
		// The confirm holds the key and the file, not the person's records.
		expect(JSON.stringify(confirm)).not.toContain('TAP office');
	});

	// Without the generations there is nothing to compare the device with, so Replace must not write on a guess.
	it('Replace pressed with no generations read does nothing', async () => {
		const phone = await newPhone();
		const r = restoreRig(phone);
		await toConfirm(r, backupFile());
		// The file and the key are still held; only the read the confirm stands on is missing.
		const run = need(r.session.beginRun());
		run.hold('confirm', null);
		run.release();
		const before = await sevenRows(phone.db);
		await r.flow.replace();
		expect(restoreBackup).not.toHaveBeenCalled();
		expect(r.session.busy).toBe(false);
		expect(r.session.phase).toBe('confirm');
		expect(await sevenRows(phone.db)).toStrictEqual(before);
	});

	it('a new phone with nothing saved says so and does not warn', async () => {
		const phone = await newPhone();
		const r = restoreRig(phone);
		await toConfirm(r, backupFile());
		const confirm = need(r.flow.confirm);
		expect(confirm.deviceLine).toBe(DEVICE_NO_DATA_LINE);
		expect(confirm.warning).toBe(false);
	});

	// Restoring the backup this very phone just made loses nothing, so there is nothing to warn about, and the line says
	// the phone is exactly that backup.
	it('a backup made here and restored here: no warning, the line names the backup date', async () => {
		const device = await finishedDevice(await newDb());
		const madeAt = Date.now() - MINUTE;
		const file = await exportFrom(device, { createdAt: madeAt });
		const r = restoreRig({ db: device.db, store: device.profile });
		await toConfirm(r, file);
		const confirm = need(r.flow.confirm);
		expect(confirm.deviceLine).toBe(
			'This device was last changed when its backup of ' + formatBackupDate(madeAt) + ' was made.'
		);
		expect(confirm.warning).toBe(false);
	});

	// Anything saved since the backup would be replaced, so the person is told before they press Replace.
	it('a change after the backup warns, and the line dates the change', async () => {
		const device = await finishedDevice(await newDb());
		const file = await exportFrom(device, { createdAt: Date.now() - MINUTE });
		await device.timeline.setStatus('sha-schedule', 'done');
		const state = await readDeviceState(device.db);
		const r = restoreRig({ db: device.db, store: device.profile });
		await toConfirm(r, file);
		const confirm = need(r.flow.confirm);
		expect(confirm.deviceLine).toBe(
			'This device was last changed ' + formatBackupDate(need(state.ts.timeline)) + '.'
		);
		expect(confirm.warning).toBe(true);
		expect(DEVICE_NEWER_WARNING).toContain('newer than this backup');
	});

	// Another tab saving the profile in the gap between the snapshot and the mark leaves a device that holds a change the
	// backup lacks, whether or not the mark landed.
	it('a profile saved by another tab before the mark is written still warns', async () => {
		const device = await finishedDevice(await newDb());
		const peer = createProfileStore(device.db);
		profiles.push(peer);
		const file = await exportFrom(device, {
			createdAt: Date.now() - MINUTE,
			between: async () => {
				await peer.load();
				await peer.save({ yearsOfService: 3 });
			}
		});
		const r = restoreRig({ db: device.db, store: device.profile });
		await toConfirm(r, file);
		const confirm = need(r.flow.confirm);
		expect(confirm.deviceLine).toMatch(/^This device was last changed (?!when its backup)/);
		expect(confirm.warning).toBe(true);
	});

	// The phone holds exactly the content of the last backup it made or restored, so the second restore replaces nothing
	// newer in one order and something newer in the other.
	it.each<[string, number, number, boolean]>([
		['an older backup then the newer one', 3 * DAY, DAY, false],
		['the newer backup then the older one', DAY, 3 * DAY, true]
	])('restoring %s warns: %s', async (_name, firstAge, secondAge, warns) => {
		const source = await finishedDevice(await newDb());
		const first = await exportFrom(source, { createdAt: Date.now() - firstAge }, OUR_NAME);
		const second = await exportFrom(source, { createdAt: Date.now() - secondAge }, OUR_NAME);
		const phone = await newPhone();

		const one = restoreRig(phone);
		await toConfirm(one, first);
		await one.flow.replace();
		expect(one.session.phase).toBe('committed');

		// The page reloaded after the first restore: a new tab's session.
		const two = restoreRig(phone);
		await toConfirm(two, second);
		expect(need(two.flow.confirm).warning).toBe(warns);
	});

	// A backup stamped before the app existed has no believable date, so the phone's changes cannot be shown to be older.
	it('a backup with an unknown date warns when the device has changes', async () => {
		const phone = await newPhone();
		const source = await finishedDevice(await newDb());
		const file = await exportFrom(source, { createdAt: BACKUP_RELEASE_DATE - 1000 });
		const crafted: DeviceState = {
			gens: { profile: 1, timeline: 0, calendar: 0 },
			ts: { profile: BACKUP_RELEASE_DATE - 5000, timeline: null, calendar: null },
			mark: null,
			lastSeenAt: null
		};
		const r = restoreRig(phone, {
			readDevice: async () => ({ state: crafted, installUuid: new Uint8Array(16) })
		});
		await toConfirm(r, file);
		const confirm = need(r.flow.confirm);
		expect(confirm.deviceLine).toBe('This device was last changed date unknown.');
		expect(confirm.warning).toBe(true);
	});

	it('lists what no backup carries, with the API key said as kept on this device', () => {
		expect(NOT_IN_BACKUPS).toEqual([
			'your API key (kept on this device if one is saved)',
			"Ask's offline library",
			'saved documents',
			"this device's settings (theme, Ask mode)"
		]);
	});
});

// ---- Replace -------------------------------------------------------------------------------------------------------

describe('Replace', () => {
	async function restoredNewPhone() {
		const source = await finishedDevice(await newDb());
		const file = await exportFrom(source, { createdAt: Date.now() - MINUTE });
		const phone = await newPhone();
		const r = restoreRig(phone);
		await toConfirm(r, file);
		await r.flow.replace();
		return { r, phone, source };
	}

	// The whole point: a backup from another phone becomes this phone's data, and the app opens on it after a reload.
	it('puts the backup on a new phone, tells the other tabs once, and keeps no secret', async () => {
		const { r, phone, source } = await restoredNewPhone();
		expect(r.session.phase).toBe('committed');
		expect(r.published).toEqual([{ type: 'data-replaced' }]);
		for (const slot of ['key', 'parsed', 'confirm', 'fileBytes'] as const) {
			expect(r.session.held(slot)).toBeNull();
		}
		expect(r.field.value).toBe('');

		const reloaded = createProfileStore(phone.db);
		profiles.push(reloaded);
		const loaded = need(await reloaded.load());
		expect(decodeEaos(need(loaded.eaos))).toBe('2028-02-01');
		const timeline = createTimelineStateStore(phone.db);
		await timeline.load();
		expect(JSON.parse(JSON.stringify(timeline.state))).toEqual(
			JSON.parse(JSON.stringify(source.timeline.state))
		);
		const calendar = createCalendarSyncStore(phone.db);
		await calendar.load();
		expect(calendar.exclusions).toEqual({ taskIds: ['sha-schedule'], categories: ['finance'] });
	});

	// A reload that kept the note is what lets the Timeline say what happened; a replace of the location would drop it.
	it('reloads once with the restored note and the address on the Timeline', async () => {
		const { r } = await restoredNewPhone();
		expect(r.reload).toHaveBeenCalledTimes(1);
		expect(r.replace).not.toHaveBeenCalled();
		expect(new URL(location.href).pathname).toBe(resolve('/timeline'));
		expect(takeBackupIntent('restored')).toBe(true);
		expect(takeBackupIntent('restored')).toBe(false);
		expect(r.app.reloadOnUnlock).toBe(false);
	});

	// Between the confirm and Replace the file may be tampered with in memory or the device may have moved; the file is
	// opened and checked again, and the writer gets that fresh result.
	it('opens and checks the held file again, then hands the writer what that check returned', async () => {
		const phone = await newPhone();
		const r = restoreRig(phone);
		await toConfirm(r, backupFile());
		expect(decryptEnvelope).toHaveBeenCalledTimes(1);
		expect(validateInner).toHaveBeenCalledTimes(1);
		await r.flow.replace();
		expect(decryptEnvelope).toHaveBeenCalledTimes(2);
		expect(validateInner).toHaveBeenCalledTimes(2);
		const checkedAgain = vi.mocked(validateInner).mock.results[1]?.value as {
			ok: true;
			inner: unknown;
		};
		expect(vi.mocked(validateInner).mock.invocationCallOrder[1]).toBeLessThan(
			need(vi.mocked(restoreBackup).mock.invocationCallOrder[0])
		);
		expect(vi.mocked(restoreBackup).mock.calls[0]?.[1]).toBe(checkedAgain.inner);
	});

	// Something else saved on the phone while the person was deciding: nothing is replaced, they see fresh details.
	it('a change made while the confirm was open re-checks instead of overwriting, then Replace works', async () => {
		const device = await finishedDevice(await newDb(), '2027-01-01');
		const source = await finishedDevice(await newDb());
		const file = await exportFrom(source, { createdAt: Date.now() - MINUTE });
		const r = restoreRig({ db: device.db, store: device.profile });
		await toConfirm(r, file);
		const first = need(r.flow.confirm);
		await device.timeline.setStatus('sha-schedule', 'done');
		const before = await sevenRows(device.db);

		await r.flow.replace();
		expect(r.session.phase).toBe('confirm');
		expect(r.session.busy).toBe(false);
		const again = need(r.flow.confirm);
		expect(again.notice).toBe('E_RESTORE_DEVICE_MOVED');
		expect(r.flow.lineFor('E_RESTORE_DEVICE_MOVED')).toContain('changed while you were deciding');
		expect(again.gens.timeline).toBe(first.gens.timeline + 1);
		expect(await sevenRows(device.db)).toStrictEqual(before);
		expect(r.published).toEqual([]);

		await r.flow.replace();
		expect(r.session.phase).toBe('committed');
	});

	// A phone whose saved data is damaged, or that was erased from another tab, refuses before the write and says so, at
	// the confirm and at Replace alike.
	const tamper = {
		damaged: async (db: IDBDatabase): Promise<void> => {
			const row = need(await readRaw(db, 'timeline-state-hwm'));
			const mac = new Uint8Array(row.mac as ArrayBuffer).slice();
			mac[0] = (mac[0] ?? 0) ^ 1;
			await withStores(db, 'timeline-state-hwm', 'readwrite', (tx) => {
				tx.objectStore('timeline-state-hwm').put({ ...row, mac: mac.buffer });
			});
		},
		forged: async (db: IDBDatabase): Promise<void> => {
			const row = need(await readRaw(db, 'keystore'));
			const mac = new Uint8Array(row.recordHmac as ArrayBuffer).slice();
			mac[0] = (mac[0] ?? 0) ^ 1;
			await withStores(db, 'keystore', 'readwrite', (tx) => {
				tx.objectStore('keystore').put({ ...row, recordHmac: mac.buffer });
			});
		},
		changed: async (db: IDBDatabase): Promise<void> => {
			await withStores(db, 'keystore', 'readwrite', (tx) => {
				tx.objectStore('keystore').clear();
			});
		}
	};
	it.each<['damaged' | 'forged' | 'changed', 'checking' | 'Replace', string]>([
		['damaged', 'checking', 'E_RESTORE_DEVICE_DAMAGED'],
		['damaged', 'Replace', 'E_RESTORE_DEVICE_DAMAGED'],
		['forged', 'checking', 'E_RESTORE_DEVICE_DAMAGED'],
		['changed', 'checking', 'E_RESTORE_DEVICE_CHANGED'],
		['changed', 'Replace', 'E_RESTORE_DEVICE_CHANGED']
	])('a %s device found while %s writes nothing and says why', async (kind, stage, code) => {
		const device = await finishedDevice(await newDb(), '2027-01-01');
		const r = restoreRig({ db: device.db, store: device.profile });
		if (stage === 'checking') {
			await toFileChosen(r, backupFile());
			await tamper[kind](device.db);
			const before = await sevenRows(device.db);
			await r.flow.submit(PHRASE);
			expect(await sevenRows(device.db)).toStrictEqual(before);
		} else {
			await toConfirm(r, backupFile());
			await tamper[kind](device.db);
			const before = await sevenRows(device.db);
			await r.flow.replace();
			expect(await sevenRows(device.db)).toStrictEqual(before);
		}
		expect(r.session.message).toBe(code);
		expect(r.session.phase).toBe('file-chosen');
		expect(r.session.busy).toBe(false);
		expect(r.flow.view.offerErase).toBe(kind !== 'changed');
		expect(r.published).toEqual([]);
		if (kind !== 'changed') {
			expect(r.flow.view.line).toContain('Nothing on this device was changed');
			r.flow.requestErase();
			expect(r.session.takeEraseRequest()).toBe(true);
		}
	});

	// A phone that runs out of room at the last moment keeps everything it had, and the person can try again.
	it('a write that fails part-way leaves every row as it was and lets the person try again', async () => {
		const device = await finishedDevice(await newDb(), '2027-01-01');
		const r = restoreRig({ db: device.db, store: device.profile });
		await toConfirm(r, backupFile());
		const before = await sevenRows(device.db);
		const put = IDBObjectStore.prototype.put;
		const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
			this: IDBObjectStore,
			value: unknown,
			key?: IDBValidKey
		) {
			if (this.name === 'timeline-state') throw new DOMException('full', 'QuotaExceededError');
			return put.call(this, value, key);
		});
		await r.flow.replace();
		spy.mockRestore();

		expect(await sevenRows(device.db)).toStrictEqual(before);
		expect(r.session.message).toBe('E_WRITE_FAILED');
		expect(r.flow.view.line).toContain('Nothing on this device was changed');
		expect(r.session.committing).toBe(false);
		expect(r.session.phase).toBe('file-chosen');
		expect(r.session.busy).toBe(false);
		expect(r.published).toEqual([]);

		await r.flow.submit(PHRASE);
		await r.flow.replace();
		expect(r.session.phase).toBe('committed');
	});

	// Cancel pressed while Replace is queued behind another save: the request is withdrawn, nothing is written, no tab is
	// told, and the person reads the stopped line.
	it('Cancel while Replace waits for the database writes nothing and ends with the stopped line', async () => {
		const device = await finishedDevice(await newDb(), '2027-01-01');
		const r = restoreRig({ db: device.db, store: device.profile });
		await toConfirm(r, backupFile());
		const before = await sevenRows(device.db);
		const granted = deferred<void>();
		const other = deferred<void>();
		void navigator.locks.request('mtc-keystore', { mode: 'shared' }, () => {
			granted.resolve();
			return other.promise;
		});
		await granted.promise;

		const replacing = r.flow.replace();
		await vi.waitFor(() => expect(restoreBackup).toHaveBeenCalledTimes(1));
		expect(r.session.cancel()).toBe(true);
		other.resolve();
		await replacing;

		expect(await sevenRows(device.db)).toStrictEqual(before);
		expect(r.session.stopping).toBe(false);
		expect(r.session.message).toBe('E_RESTORE_CANCELLED');
		expect(r.published).toEqual([]);
		expect(r.reload).not.toHaveBeenCalled();
	});

	// A lock that lands in the writer's window can neither stop the write nor leave the page open on stale data.
	describe('a lock or a leave during the write', () => {
		it('a returning user who was locked stays locked, and a later lock changes the line', async () => {
			const device = await finishedDevice(await newDb(), '2027-01-01');
			const file = await exportFrom(device, { createdAt: Date.now() - MINUTE });
			const r = restoreRig({ db: device.db, store: device.profile });
			await toConfirm(r, file);
			duringCommit(r, () => {
				device.profile.relockSync('user');
				r.session.relockSync('user');
			});
			await r.flow.replace();
			expect(r.session.phase).toBe('committed');
			expect(r.reload).not.toHaveBeenCalled();
			expect(r.app.reloadOnUnlock).toBe(true);
			expect(r.flow.view.restored).toEqual({ line: RESTORED_UNLOCK_LINE, reloadButton: false });
			expect(r.published).toEqual([{ type: 'data-replaced' }]);

			r.session.relockSync('user');
			expect(r.flow.view.restored?.line).toBe(LOCKED_AFTER_RESTORE_LINE);
		});

		it('a first-run tab that was locked is told to reload and reloads only when the person asks', async () => {
			const phone = await newPhone();
			const r = restoreRig(phone);
			await toConfirm(r, backupFile());
			duringCommit(r, () => {
				phone.store.relockSync('user');
				r.session.relockSync('user');
			});
			await r.flow.replace();
			expect(r.reload).not.toHaveBeenCalled();
			expect(r.app.reloadOnUnlock).toBe(false);
			expect(r.flow.view.restored).toEqual({ line: RESTORED_RELOAD_LINE, reloadButton: true });

			r.flow.reloadNow();
			expect(r.reload).toHaveBeenCalledTimes(1);
			expect(takeBackupIntent('restored')).toBe(true);
		});

		// Leaving the app, the page leaving, or the person navigating is not a lock: the restored data is still theirs to see.
		it.each<[string, (r: Rig) => void]>([
			['an app switch', (r) => r.session.relockSync('hygiene')],
			['the card leaving', (r) => r.session.cardGone()],
			['the page leaving', (r) => r.win.dispatchEvent(new Event('pagehide'))]
		])('%s still reloads onto the Timeline', async (_name, act) => {
			const phone = await newPhone();
			const r = restoreRig(phone);
			await toConfirm(r, backupFile());
			duringCommit(r, () => act(r));
			await r.flow.replace();
			expect(r.session.phase).toBe('committed');
			expect(r.reload).toHaveBeenCalledTimes(1);
			expect(r.flow.view.restored).toEqual({ line: null, reloadButton: false });
		});

		// A stop that reaches the run after the writer committed must not cost the other tabs their signal.
		it('a stop signal that arrives after the commit still publishes and finishes', async () => {
			const phone = await newPhone();
			const r = restoreRig(phone);
			await toConfirm(r, backupFile());
			duringCommit(r, () => r.session.abortRun('late'));
			await r.flow.replace();
			expect(r.session.phase).toBe('committed');
			expect(r.published).toEqual([{ type: 'data-replaced' }]);
			expect(r.reload).toHaveBeenCalledTimes(1);
		});

		// A page nobody can see is not reloaded under the person; and if a lock comes while it waits, the reload is off.
		it('a hidden page reloads when it is next shown', async () => {
			const phone = await newPhone();
			const r = restoreRig(phone);
			await toConfirm(r, backupFile());
			r.visible.value = false;
			await r.flow.replace();
			expect(r.reload).not.toHaveBeenCalled();
			r.visible.value = true;
			need(r.waiting.fn)();
			expect(r.reload).toHaveBeenCalledTimes(1);
		});

		it('a hidden page that is locked before it is shown does not reload and waits for the unlock', async () => {
			const device = await finishedDevice(await newDb(), '2027-01-01');
			const file = await exportFrom(device, { createdAt: Date.now() - MINUTE });
			const r = restoreRig({ db: device.db, store: device.profile });
			await toConfirm(r, file);
			r.visible.value = false;
			await r.flow.replace();
			expect(r.reload).not.toHaveBeenCalled();
			device.profile.relockSync('user');
			r.session.relockSync('user');
			r.visible.value = true;
			need(r.waiting.fn)();
			expect(r.reload).not.toHaveBeenCalled();
			expect(r.app.reloadOnUnlock).toBe(true);
			expect(r.flow.view.restored?.line).toBe(LOCKED_AFTER_RESTORE_LINE);
		});
	});
});

// ---- Check ---------------------------------------------------------------------------------------------------------

describe('Check', () => {
	// Check answers "can I trust this file" and nothing else: no device read, no write, no signal to other tabs.
	it('says the backup opens and writes nothing, reads no device and tells no tab', async () => {
		const device = await finishedDevice(await newDb(), '2027-01-01');
		const before = await sevenRows(device.db);
		const read = vi.fn(realRead);
		const r = restoreRig({ db: device.db, store: device.profile }, { readDevice: read });
		await toFileChosen(r, backupFile(), 'check');
		r.field.value = PHRASE;
		await r.flow.submit(PHRASE);
		expect(r.session.phase).toBe('done');
		const checked = need(r.flow.view.checked);
		expect(checked.line).toBe(
			'This backup opens. Made on ' + formatBackupDate(FILE_CREATED_AT) + '.'
		);
		expect(checked.summary).toMatchObject({ tasks: 2, notes: 1, calendarExclusions: 2 });
		expect(read).not.toHaveBeenCalled();
		expect(restoreBackup).not.toHaveBeenCalled();
		expect(r.published).toEqual([]);
		expect(r.session.held('key')).toBeNull();
		expect(r.field.value).toBe('');
		expect(await sevenRows(device.db)).toStrictEqual(before);
		r.flow.close();
		expect(r.session.phase).toBe('idle');
	});

	// A device whose own data is damaged can still check a backup before it is erased; there is no database to read.
	it('works on a damaged app with no database and no way to tell other tabs', async () => {
		const r = makeRig({ db: null, status: 'damaged' });
		await toFileChosen(r, backupFile(), 'check');
		await r.flow.submit(PHRASE);
		expect(r.session.phase).toBe('done');
		expect(r.flow.view.checked?.line).toContain('This backup opens');
	});
});
