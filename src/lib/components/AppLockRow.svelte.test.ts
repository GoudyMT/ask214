import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cdp, page } from 'vitest/browser';
import AppLockRow, { type AppLockDeps } from './AppLockRow.svelte';
import BackupCard from '../backup/BackupCard.svelte';
import { lastBackupLine } from '../backup/copy';
import { formatBackupDate } from '../backup/dates';
import type { SaveHandle, SaveWritable } from '../backup/export-flow';
import { backupSession, BackupSession, type WorkerLike } from '../backup/session.svelte';
import { KDF_V1 } from '../backup/kdf-params';
import type { FromWorker, WorkerRequest } from '../backup/worker/protocol';
import { LockAcquisitionTimeout } from '../db/locks';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { withStores } from '../db/schema';
import { bumpCounter, readCounter, readTries, type TriesState } from '../keystore/app-lock-store';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { PinNoMemoryError } from '../keystore/pin-derive';
import { RotationStoreError, rotateToPin } from '../keystore/rotate';
import {
	dropSession,
	getSession,
	KeystoreLockedError,
	openPinSession,
	setSession,
	WrongPinError,
	type KeySession
} from '../keystore/session';
import type { KeystoreRecordPin } from '../keystore/record';
import { readPinRowAndCounter } from '../keystore/unlock-row';
import { createJoinRelock, relockEachSync, type Relockable } from '../profile/app-init';
import { readDeviceState } from '../profile/device-state';
import { encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { createProfileStore } from '../profile/store.svelte';
import type { BusSignal } from '../broadcast/bus';
import { CHECK_LOW_MEMORY_LINE, NOT_RIGHT_LINE, waitLine } from './pin-lines';

type TestApp = {
	status: 'ready';
	db: IDBDatabase;
	joinRelock: (r: Relockable) => () => void;
	publish: Mock<(signal: BusSignal) => void>;
	keyMode: 'local' | 'pin';
	pinLocked: boolean;
	// Null keeps the backup card inert (a card with no profile store has nothing it may start); a test that lets it run
	// sets a store.
	store: unknown;
};

// Which tasks ran, in order, so a test can see that nothing ran between two of them.
const seams = vi.hoisted(() => ({
	events: [] as string[],
	app: {} as Record<string, unknown>,
	// What the backup step handed the backup card, as the card was mounted, and what a test adds to it (the card's own
	// seams: its session, the save picker).
	card: null as Record<string, unknown> | null,
	cardExtra: {} as Record<string, unknown>
}));
vi.mock('$lib/profile/context', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/profile/context')>()),
	getProfileApp: () => seams.app
}));
// The real card, drawn as it is; the wrapper only keeps the props it was mounted with and adds a test's seams.
vi.mock('$lib/backup/BackupCard.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/backup/BackupCard.svelte')>();
	const mount = real.default as unknown as (
		anchor: unknown,
		props: Record<string, unknown>
	) => unknown;
	return {
		...real,
		default: (anchor: unknown, props: Record<string, unknown>) => {
			seams.card = props;
			seams.events.push('card');
			return mount(anchor, { ...props, ...seams.cardExtra });
		}
	};
});
vi.mock('$lib/keystore/session', async (importOriginal) => {
	const real = await importOriginal<typeof import('../keystore/session')>();
	return {
		...real,
		setSession: (session: KeySession) => {
			seams.events.push('setSession');
			real.setSession(session);
		}
	};
});

const HMAC = { name: 'HMAC', hash: 'SHA-256', length: 256 } as const;
const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};

const UP_FRONT_1 = 'A PIN keeps other people out of your saved information on this phone.';
const UP_FRONT_2 = "Don't use your phone's unlock PIN.";
const PIN_ON_LINE =
	'The app asks for your PIN when it opens, after 15 minutes idle, and after Lock.';
const FORMAT_LINE = 'Use 4 to 6 digits.';
const MISMATCH_LINE = 'The two PINs do not match.';
const LOW_MEMORY_LINE =
	'This phone does not have enough free memory for a PIN. Close other apps and tabs, then try again.';
const FAILED_LINE = 'Could not turn on the PIN right now - please try again.';
const PACK_LINE = 'Offline SkillBridge listings download again.';
const STORE_LINE = (name: string) =>
	`The PIN was not turned on: your saved ${name} could not be opened. Nothing was changed. Erase all data on this device starts over.`;
const CHANGE_STORE_LINE = (name: string) =>
	`The PIN was not changed: your saved ${name} could not be opened. Nothing was changed. Erase all data on this device starts over.`;
const CHANGE_FAILED_LINE = 'Could not change the PIN right now - please try again.';
const REMOVE_FAILED_LINE = 'Could not remove the PIN right now - please try again.';
const CHANGED_LINE = 'PIN changed.';
const REMOVED_LINE = 'PIN removed.';
const REMOVE_HINT = 'Anyone with your phone can open the app. Your data stays on this device.';

// The PINs the PIN-on tests type: the right one, a wrong one and the one a change moves to.
const CURRENT = '1234';
const WRONG = '9999';
const NEW_PIN = '5678';

// Captured before any test fakes a timer: the waits below must stay real.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const real = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** Waits for something the page does in its own time; a state that never comes is a failed assertion that names it. */
async function until(
	check: () => boolean | Promise<boolean>,
	what: string,
	ms = 2_000
): Promise<void> {
	for (let waited = 0; !(await check()); waited += 20) {
		if (waited >= ms) expect(false, `never came: ${what}`).toBe(true);
		await real(20);
	}
}

async function fakeSession(): Promise<KeySession> {
	const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
		'encrypt',
		'decrypt'
	]);
	const hmacKey = await crypto.subtle.generateKey(HMAC, false, ['sign', 'verify']);
	return {
		dataKey,
		hmacKey,
		bootstrapMacKey: hmacKey,
		identity: { v: 1, keystoreGeneration: 1, epoch: 1, installUuid: new Uint8Array(16) },
		counter: 1
	};
}

// Reactive, as the layout's app object is: the row reads its summary from the mode.
const mode = $state({ value: 'local' as 'local' | 'pin' });

let db: IDBDatabase;
let app: TestApp;
let relockables: Relockable[];
let macKey: CryptoKey;
let kek: CryptoKey;
let clock: { t: number };
let derive: Mock<(pin: string) => Promise<{ macKey: CryptoKey; kek: CryptoKey }>>;
let rotate: Mock<() => Promise<{ session: KeySession; packHadFiles: boolean }>>;
let remove: Mock<() => Promise<void>>;
// The keys a PIN-on test's fake derive hands back for the PIN a change moves to, and for a PIN that is wrong.
let newKeys: { macKey: CryptoKey; kek: CryptoKey };
let wrongKeys: { macKey: CryptoKey; kek: CryptoKey };
// What each derive saw of the tries row at the moment it ran.
let deriveLog: { pin: string; tries: TriesState }[];
// The wait clock's interval, held so a test can run it when it chooses.
let runWaitClock: (() => void) | null;

beforeEach(async () => {
	db = await openTestDb();
	seams.events.length = 0;
	seams.card = null;
	seams.cardExtra = {};
	mode.value = 'local';
	relockables = [];
	app = {
		status: 'ready',
		db,
		joinRelock: createJoinRelock(relockables),
		publish: vi.fn(),
		pinLocked: false,
		store: null,
		get keyMode() {
			return mode.value;
		},
		set keyMode(next: 'local' | 'pin') {
			mode.value = next;
		}
	};
	seams.app = app;
	macKey = await crypto.subtle.generateKey(HMAC, false, ['sign', 'verify']);
	kek = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, [
		'wrapKey',
		'unwrapKey'
	]);
	newKeys = await fixedKeys(11);
	wrongKeys = await fixedKeys(13);
	clock = { t: 0 };
	deriveLog = [];
	runWaitClock = null;
	derive = vi.fn(async () => ({ macKey, kek }));
	rotate = vi.fn(async () => ({ session: await fakeSession(), packHadFiles: false }));
	remove = vi.fn(async () => {});
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	// The backup session is the tab's one: a step that started it must not leave it running for the next test.
	backupSession.relockSync('user');
	dropSession();
	await deleteTestDb(db);
});

// Fixed key bytes, so a PIN's keys are the same wherever a test asks for them. The derive's own Argon2id is the worker's.
async function fixedKeys(byte: number): Promise<{ macKey: CryptoKey; kek: CryptoKey }> {
	return {
		macKey: await crypto.subtle.importKey('raw', new Uint8Array(32).fill(byte), HMAC, false, [
			'sign',
			'verify'
		]),
		kek: await crypto.subtle.importKey(
			'raw',
			new Uint8Array(32).fill(byte + 1),
			{ name: 'AES-KW' },
			false,
			['wrapKey', 'unwrapKey']
		)
	};
}

type Host = { onerase?: () => void; onbackupstep?: (up: boolean) => void };

function mount(over: AppLockDeps = {}, host: Host = {}) {
	return render(AppLockRow, {
		props: {
			...host,
			deps: {
				derive: derive as unknown as AppLockDeps['derive'],
				rotate: rotate as unknown as AppLockDeps['rotate'],
				remove: remove as unknown as AppLockDeps['remove'],
				now: () => clock.t,
				clock: {
					perfNow: () => clock.t,
					setInterval: ((run: () => void) => {
						runWaitClock = run;
						return 1;
					}) as unknown as typeof setInterval,
					clearInterval: (() => {}) as typeof clearInterval
				},
				...over
			}
		}
	});
}

const toggle = () => page.getByRole('button', { name: 'App lock' });
const toggleEl = () => toggle().element() as HTMLButtonElement;
const firstField = () => page.getByLabelText('Choose a 4-6 digit PIN', { exact: true });
const secondField = () => page.getByLabelText('Enter it again', { exact: true });
const firstEl = () => firstField().element() as HTMLInputElement;
const secondEl = () => secondField().element() as HTMLInputElement;
const nextEl = () =>
	page.getByRole('button', { name: 'Next', exact: true }).element() as HTMLElement;
const cancelEl = () =>
	page.getByRole('button', { name: 'Cancel', exact: true }).element() as HTMLElement;
const expanded = () => toggleEl().getAttribute('aria-expanded') === 'true';
const summary = () => toggleEl().textContent?.replace('App lock', '').trim();
const alertText = () => document.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
const hasText = (text: string) => document.body.textContent?.includes(text) === true;

async function openRow(): Promise<void> {
	toggleEl().click();
	await until(() => expanded(), 'the row open');
}

async function fill(a: string, b: string): Promise<void> {
	await firstField().fill(a);
	await secondField().fill(b);
}

async function submit(a: string, b: string): Promise<void> {
	await openRow();
	await fill(a, b);
	nextEl().click();
}

// The backup step that follows a good Next: nothing is turned on until one of its two buttons is pressed.
const STEP_TITLE = 'One more step: make a backup';
const STEP_HINT =
	"If you forget your PIN, your data can't be opened. A backup lets you get it back. Keep the file and its six words together.";
const MAKE_AND_TURN_ON = 'Make a backup and turn on';
const SKIP_AND_TURN_ON = 'Skip and turn on';
const makeEl = () =>
	page.getByRole('button', { name: MAKE_AND_TURN_ON, exact: true }).element() as HTMLElement;
const skipEl = () =>
	page.getByRole('button', { name: SKIP_AND_TURN_ON, exact: true }).element() as HTMLElement;
const hasStep = () => hasText(STEP_TITLE);

async function toStep(a: string, b: string): Promise<void> {
	await submit(a, b);
	await until(() => hasStep(), 'the backup step');
}

/** Next, then Skip and turn on: the way a person who wants no backup turns the PIN on. */
async function submitAndSkip(a: string, b: string): Promise<void> {
	await toStep(a, b);
	skipEl().click();
}

// The PIN-on screens. The opener and the form's own primary share a name, and only one of them is on the page at a time.
type PinButton = 'Change PIN' | 'Remove PIN';
const buttonEl = (name: PinButton): HTMLElement =>
	page.getByRole('button', { name, exact: true }).element() as HTMLElement;
const hasButton = (name: PinButton) =>
	page.getByRole('button', { name, exact: true }).query() !== null;
const currentField = () => page.getByLabelText('Enter your current PIN', { exact: true });
const currentEl = () => currentField().element() as HTMLInputElement;
const statusLines = () =>
	[...document.querySelectorAll('[role="status"] p')].map((p) => p.textContent?.trim() ?? '');
// A press is over when it has emptied what it was handed.
const fieldsEmpty = () =>
	[...document.querySelectorAll('input')].every((input) => input.value === '');
const inForm = () => document.querySelector('#app-lock-current') !== null;

/** A real device on a PIN: a local keystore moved onto the PIN the fake derive answers for CURRENT. */
async function pinOn(): Promise<KeySession> {
	await bootstrapLocalKeystore(db);
	await createProfileStore(db).save({
		setupIntent: 'completed',
		eaos: encodeEaos(parseEaosAtRead('2027-04-15')),
		yearsOfService: 4
	});
	const { session } = await rotateToPin(db, {
		macKey,
		kek,
		salt: crypto.getRandomValues(new Uint8Array(16)),
		kdf: { ...KDF_V1 },
		counterBefore: await readCounter(db)
	});
	mode.value = 'pin';
	return session;
}

/** The derive of a PIN-on device: the right keys for CURRENT, other keys for NEW_PIN, and a wrong PIN's keys for the rest. */
function deriveByPin(newPinMs = 0): void {
	derive.mockImplementation(async (pin: string) => {
		deriveLog.push({ pin, tries: await readTries(db) });
		if (pin === CURRENT) return { macKey, kek };
		if (pin !== NEW_PIN) return wrongKeys;
		clock.t += newPinMs;
		return newKeys;
	});
}

async function openForm(name: PinButton): Promise<void> {
	await openRow();
	buttonEl(name).click();
	await until(() => inForm(), 'the form');
}

async function pressChange(current: string, next: string, again: string): Promise<void> {
	await currentField().fill(current);
	await firstField().fill(next);
	await secondField().fill(again);
	buttonEl('Change PIN').click();
	await until(() => fieldsEmpty(), 'the press done');
}

async function pressRemove(current: string): Promise<void> {
	await currentField().fill(current);
	buttonEl('Remove PIN').click();
	await until(() => fieldsEmpty(), 'the press done');
}

describe('setting up: what the person is told and asked', () => {
	it('opens on the two up-front lines and the two fields', async () => {
		await mount();
		await openRow();

		expect(hasText(UP_FRONT_1)).toBe(true);
		expect(hasText(UP_FRONT_2)).toBe(true);
		expect(firstEl().type).toBe('password');
		expect(secondEl().type).toBe('password');
		expect(summary()).toBe('Off');
	});

	it('says the two PINs differ, with no derive, and empties both fields', async () => {
		await mount();
		await submit('1234', '1235');

		await until(() => alertText() !== null, 'a line');
		expect(alertText()).toBe(MISMATCH_LINE);
		expect(derive).not.toHaveBeenCalled();
		expect([firstEl().value, secondEl().value]).toEqual(['', '']);
	});

	it('says to use 4 to 6 digits for a PIN that is not, with no derive', async () => {
		await mount();
		await submit('123', '123');

		await until(() => alertText() !== null, 'a line');
		expect(alertText()).toBe(FORMAT_LINE);
		expect(derive).not.toHaveBeenCalled();
	});

	// There is no form to submit, so Enter is the keyboard's way through: from the first PIN to the second, then Next.
	it('moves from the first field to the second on Enter, and presses Next from the second', async () => {
		await mount();
		await openRow();
		await fill('1234', '1234');
		const session = cdp();
		const press = async () => {
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
			await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		};
		firstEl().focus();
		await press();
		await until(() => document.activeElement === secondEl(), 'the cursor in the second field');
		expect(derive).not.toHaveBeenCalled();

		await press();
		await until(() => hasStep(), 'the backup step');
		expect(derive).toHaveBeenCalledTimes(1);
		skipEl().click();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');
		expect(derive).toHaveBeenCalledTimes(1);
	});

	// Without the app's relock join a scrub empties the DOM but not the value the row reads on its next press.
	it('empties both fields when the app relocks', async () => {
		await mount();
		await openRow();
		await fill('1234', '1234');
		relockEachSync(relockables, 'user');

		await until(() => firstEl().value === '' && secondEl().value === '', 'both fields empty');
		nextEl().click();
		await until(() => alertText() !== null, 'a line');
		expect(alertText()).toBe(FORMAT_LINE);
		expect(derive).not.toHaveBeenCalled();
	});

	it('closes on Cancel with both fields empty, and the next opening starts empty', async () => {
		await mount();
		await openRow();
		await fill('1234', '1234');
		cancelEl().click();
		await until(() => !expanded(), 'the row closed');

		await openRow();
		expect([firstEl().value, secondEl().value]).toEqual(['', '']);
		expect(derive).not.toHaveBeenCalled();
	});
});

describe('one derive, and what it may cost', () => {
	// 5,000 ms is allowed; one more is a phone that cannot hold the PIN's derive in a short wait.
	it.each([
		[5_000, true],
		[5_001, false]
	])('with a derive of %i ms, the PIN turns on: %s', async (ms, turnsOn) => {
		derive.mockImplementation(async () => {
			clock.t += ms;
			return { macKey, kek };
		});
		await mount();
		await submit('1234', '1234');

		await until(() => alertText() !== null || hasStep(), 'a result');
		if (turnsOn) {
			skipEl().click();
			await until(() => summary() === 'PIN on', 'the row reading PIN on');
			expect(rotate).toHaveBeenCalledTimes(1);
		} else {
			expect(alertText()).toBe(LOW_MEMORY_LINE);
			expect(summary()).toBe('Off');
			expect(rotate).not.toHaveBeenCalled();
		}
	});

	it('keeps the PIN off, and says why, when the phone has no memory for the derive', async () => {
		derive.mockRejectedValue(new PinNoMemoryError());
		await mount();
		await submit('1234', '1234');

		await until(() => alertText() !== null, 'a line');
		expect(alertText()).toBe(LOW_MEMORY_LINE);
		expect(rotate).not.toHaveBeenCalled();
		expect(app.keyMode).toBe('local');
		expect([firstEl().value, secondEl().value]).toEqual(['', '']);
	});

	// The person left the page: the result may be slow because the page was in the background, and nothing should be
	// decided for them there. The form stays, and Next runs a fresh derive.
	it('writes nothing, and adds no line, when the page was hidden during the derive', async () => {
		derive.mockImplementation(async () => {
			vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
			document.dispatchEvent(new Event('visibilitychange'));
			return { macKey, kek };
		});
		await mount();
		await submit('1234', '1234');

		await until(() => derive.mock.calls.length > 0, 'the derive');
		await real(100);
		expect(rotate).not.toHaveBeenCalled();
		expect(alertText()).toBeNull();
		expect(expanded()).toBe(true);
		expect(summary()).toBe('Off');
	});
});

describe('turning on', () => {
	it('moves the records with the counter read just before, then holds the session and tells the other tabs', async () => {
		await bumpCounter(db);
		await bumpCounter(db);
		await bumpCounter(db);
		await mount();
		await submitAndSkip('1234', '1234');
		await until(() => summary() === 'PIN on', 'the row reading PIN on');

		expect(rotate).toHaveBeenCalledTimes(1);
		const [, input] = rotate.mock.calls[0] as unknown as [
			IDBDatabase,
			{ macKey: CryptoKey; kek: CryptoKey; salt: Uint8Array; kdf: unknown; counterBefore: number }
		];
		expect(input).toMatchObject({ macKey, kek, kdf: KDF_V1, counterBefore: 3 });
		expect(input.salt).toHaveLength(16);
		expect(app.publish).toHaveBeenCalledTimes(1);
		expect(app.publish).toHaveBeenCalledWith({ type: 'keys-changed' });
		expect(app.keyMode).toBe('pin');
		expect(getSession()).not.toBeNull();
		expect(hasText(PIN_ON_LINE)).toBe(true);
		expect([...document.querySelectorAll('input')]).toHaveLength(0);
		// The pressed Next is gone with the form; the person is not dropped back at the top of the page.
		await until(() => document.activeElement === toggleEl(), 'focus back on the toggle');
	});

	// Between the move and the session no task may run: the old keys are gone and the new ones are not yet held.
	it('holds the session in the same microtask as the move resolves', async () => {
		rotate.mockImplementation(async () => {
			const session = await fakeSession();
			realSetTimeout(() => seams.events.push('task'), 0);
			return { session, packHadFiles: false };
		});
		await mount();
		await submitAndSkip('1234', '1234');
		await until(() => seams.events.includes('task'), 'the next task');

		expect(seams.events).toEqual(['setSession', 'task']);
	});

	it.each([
		[true, true],
		[false, false]
	])('with a pack that held files: %s, the SkillBridge line shows: %s', async (had, shows) => {
		rotate.mockImplementation(async () => ({ session: await fakeSession(), packHadFiles: had }));
		await mount();
		await submitAndSkip('1234', '1234');
		await until(() => summary() === 'PIN on', 'the row reading PIN on');

		expect(alertText()).toBe(shows ? PACK_LINE : null);
	});
});

describe('a Lock while Next works', () => {
	// A user Lock, an idle lock and a peer's Lock each drop the keys: the ones this turn-on derives must not outlive them.
	it.each(['user', 'idle', 'peer'] as const)(
		'writes nothing, and keeps the PIN off, when a %s lock lands during the derive',
		async (reason) => {
			derive.mockImplementation(async () => {
				relockEachSync(relockables, reason);
				return { macKey, kek };
			});
			await mount();
			await submit('1234', '1234');
			await until(() => derive.mock.calls.length > 0, 'the derive');
			await real(150);

			expect(rotate).not.toHaveBeenCalled();
			expect(app.keyMode).toBe('local');
			expect(app.pinLocked).toBe(false);
			expect(app.publish).not.toHaveBeenCalled();
			expect(getSession()).toBeNull();
			expect(alertText()).toBeNull();
		}
	);

	// The move may already have committed: the PIN is on, and the tab must stay without keys, on the PIN card.
	it('holds no session, and shows the PIN lock, when a Lock lands during the move', async () => {
		rotate.mockImplementation(async () => {
			relockEachSync(relockables, 'user');
			return { session: await fakeSession(), packHadFiles: false };
		});
		await mount();
		await submitAndSkip('1234', '1234');
		await until(() => app.keyMode === 'pin', 'the mode reading PIN');

		expect(getSession()).toBeNull();
		expect(seams.events).toEqual([]);
		expect(app.pinLocked).toBe(true);
		expect(app.publish).toHaveBeenCalledTimes(1);
		expect(app.publish).toHaveBeenCalledWith({ type: 'keys-changed' });
	});

	// A switch away locks nothing: during the move it changes nothing.
	it('turns on as usual when a switch away lands during the move', async () => {
		rotate.mockImplementation(async () => {
			relockEachSync(relockables, 'hygiene');
			return { session: await fakeSession(), packHadFiles: false };
		});
		await mount();
		await submitAndSkip('1234', '1234');
		await until(() => summary() === 'PIN on', 'the row reading PIN on');

		expect(getSession()).not.toBeNull();
		expect(app.pinLocked).toBe(false);
	});
});

describe('a turn-on that fails', () => {
	const NAMES = [
		['profile', 'profile'],
		['timeline-state', 'timeline'],
		['calendar-sync', 'calendar settings'],
		['byok', 'API key'],
		['skillbridge-finder', 'SkillBridge saves']
	] as const;

	async function failsWith(error: Error, line: string): Promise<void> {
		rotate.mockRejectedValue(error);
		await mount();
		await submitAndSkip('1234', '1234');
		await until(() => alertText() !== null, 'a line');

		expect(alertText()).toBe(line);
		expect(summary()).toBe('Off');
		expect(app.keyMode).toBe('local');
		expect(getSession()).toBeNull();
		expect(seams.events).toEqual([]);
		expect(app.publish).not.toHaveBeenCalled();
		expect([firstEl().value, secondEl().value]).toEqual(['', '']);
	}

	it.each(NAMES)('names the %s store that would not open, as "%s"', async (store, name) => {
		await failsWith(new RotationStoreError(store), STORE_LINE(name));
	});

	it.each([
		['the lock moved meanwhile', new Error('E_ROTATE_MOVED')],
		['the keystore lock was busy', new LockAcquisitionTimeout()],
		['anything else', new Error('E_ROTATE_WRITE')]
	])('says to try again when %s', async (_name, error) => {
		await failsWith(error, FAILED_LINE);
	});
});

describe('the backup step', () => {
	const savedOf = (): (() => void) => {
		const saved = seams.card?.onsaved;
		if (typeof saved !== 'function') throw new Error('test setup: the card was not given onsaved');
		return saved as () => void;
	};

	async function toCard(host: Host = {}): Promise<void> {
		await mount({}, host);
		await toStep('1234', '1234');
		makeEl().click();
		await until(() => seams.card !== null, 'the backup card');
	}

	it('follows a good Next with its two lines and two buttons, and changes nothing on the device', async () => {
		await mount();
		await toStep('1234', '1234');

		const lines = [...document.querySelectorAll('#app-lock-edit p')].map((p) =>
			p.textContent?.trim()
		);
		expect(lines).toEqual([STEP_TITLE, STEP_HINT]);
		const buttons = [...document.querySelectorAll('#app-lock-edit button')].map((b) =>
			b.textContent?.trim()
		);
		expect(buttons).toEqual([MAKE_AND_TURN_ON, SKIP_AND_TURN_ON]);
		// The PIN is not on the page any more, and nothing has moved yet.
		expect(document.querySelectorAll('input')).toHaveLength(0);
		expect(derive).toHaveBeenCalledTimes(1);
		expect(rotate).not.toHaveBeenCalled();
		expect(app.publish).not.toHaveBeenCalled();
		expect(app.keyMode).toBe('local');
		expect(summary()).toBe('Off');
		expect(getSession()).toBeNull();
		expect(seams.card).toBeNull();
		await until(() => document.activeElement === makeEl(), 'focus on the first button');
	});

	it('turns on from Skip and turn on without starting a backup', async () => {
		await mount();
		await toStep('1234', '1234');
		skipEl().click();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');

		expect(seams.card).toBeNull();
		expect(backupSession.active).toBe(false);
		expect(hasStep()).toBe(false);
	});

	it('mounts the card as the Make row alone and turns on only after the card reports a saved backup', async () => {
		const onerase = vi.fn();
		await toCard({ onerase });

		const card = seams.card;
		expect(card?.only).toEqual({ row: 'export', label: MAKE_AND_TURN_ON, open: true });
		expect(card?.db).toBe(db);
		(card?.onEraseRequest as () => void)();
		expect(onerase).toHaveBeenCalledTimes(1);
		// The card stands in place of the button (its row toggle now bears that name); Skip stays under it, and nothing has
		// moved yet.
		expect(makeEl().getAttribute('aria-expanded')).not.toBeNull();
		expect(skipEl()).not.toBeNull();
		expect(rotate).not.toHaveBeenCalled();
		expect(summary()).toBe('Off');

		savedOf()();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');
		expect(rotate).toHaveBeenCalledTimes(1);
		expect(app.publish).toHaveBeenCalledWith({ type: 'keys-changed' });
		expect(getSession()).not.toBeNull();
	});

	it('still turns on from Skip and turn on while the card is up', async () => {
		await toCard();
		skipEl().click();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');

		expect(rotate).toHaveBeenCalledTimes(1);
	});

	// The step's keys are the ones derived on Next; a turn-on from the step must move the records onto those.
	it('turns on with the keys derived on Next', async () => {
		await mount();
		await toStep('1234', '1234');
		skipEl().click();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');

		const [, input] = rotate.mock.calls[0] as unknown as [
			IDBDatabase,
			{ macKey: CryptoKey; kek: CryptoKey }
		];
		expect(input.macKey).toBe(macKey);
		expect(input.kek).toBe(kek);
	});

	// A Lock, an idle lock or a peer's Lock takes the keys away from the tab: the ones this step holds must not outlive it.
	it.each(['user', 'idle', 'peer'] as const)(
		'drops the keys, and turns nothing on, when a %s lock lands during the step',
		async (reason) => {
			await toCard();
			relockEachSync(relockables, reason);
			await until(() => !hasStep(), 'the step gone');

			expect([firstEl().value, secondEl().value]).toEqual(['', '']);
			// A saved report that was already on its way finds no keys.
			savedOf()();
			await real(150);
			expect(rotate).not.toHaveBeenCalled();
			expect(app.keyMode).toBe('local');
			expect(app.publish).not.toHaveBeenCalled();
			expect(getSession()).toBeNull();
			expect(alertText()).toBeNull();
		}
	);

	// A switch away locks nothing, and the derive is already done: the step stays and still turns on.
	it('keeps the step, and the keys, through a switch away', async () => {
		await mount();
		await toStep('1234', '1234');
		relockEachSync(relockables, 'hygiene');
		await real(50);

		expect(hasStep()).toBe(true);
		skipEl().click();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');
		expect(rotate).toHaveBeenCalledTimes(1);
	});

	it('drops the keys when the row is closed, so a late saved report turns nothing on', async () => {
		await toCard();
		const late = savedOf();
		toggleEl().click();
		await until(() => !expanded(), 'the row closed');

		late();
		await real(150);
		expect(rotate).not.toHaveBeenCalled();
		expect(summary()).toBe('Off');
		await openRow();
		expect(hasStep()).toBe(false);
		expect([firstEl().value, secondEl().value]).toEqual(['', '']);
	});

	it('drops the keys when the row goes, so a late saved report turns nothing on', async () => {
		const view = await mount();
		await toStep('1234', '1234');
		makeEl().click();
		await until(() => seams.card !== null, 'the backup card');
		const late = savedOf();
		view.unmount();

		late();
		await real(150);
		expect(rotate).not.toHaveBeenCalled();
		expect(app.keyMode).toBe('local');
	});

	// The page's own full backup card shares the tab's one backup session, so it must be off the page before the step's card
	// mounts and may come back only once the step's card is gone.
	describe('telling the host the step has a card up', () => {
		let calls: string[];
		const onbackupstep = (up: boolean) => {
			calls.push(up ? 'up' : 'down');
			seams.events.push(up ? 'up' : 'down');
		};
		beforeEach(() => {
			calls = [];
		});

		it('says up before the card mounts, and says nothing for a step that never made a backup', async () => {
			await mount({}, { onbackupstep });
			await toStep('1234', '1234');
			expect(calls).toEqual([]);

			makeEl().click();
			await until(() => seams.card !== null, 'the backup card');
			expect(calls).toEqual(['up']);
			// The card came after the word, with a tick between them for the page to take its own card away.
			expect(seams.events.indexOf('up')).toBeLessThan(seams.events.indexOf('card'));
		});

		it('says nothing when Skip and turn on ends a step that never made a backup', async () => {
			await mount({}, { onbackupstep });
			await submitAndSkip('1234', '1234');
			await until(() => summary() === 'PIN on', 'the row reading PIN on');

			expect(calls).toEqual([]);
		});

		it.each([
			[
				'the turn-on',
				async () => {
					skipEl().click();
					await until(() => summary() === 'PIN on', 'the row reading PIN on');
				}
			],
			[
				'the row closing',
				async () => {
					toggleEl().click();
					await until(() => !expanded(), 'the row closed');
				}
			],
			[
				'a Lock',
				async () => {
					relockEachSync(relockables, 'user');
					await until(() => !hasStep(), 'the step gone');
				}
			]
		])('says down once when the card goes with %s', async (_way, leave) => {
			await mount({}, { onbackupstep });
			await toStep('1234', '1234');
			makeEl().click();
			await until(() => seams.card !== null, 'the backup card');
			await leave();
			await real(50);

			expect(calls).toEqual(['up', 'down']);
		});

		it('says down when the row goes', async () => {
			const view = await mount({}, { onbackupstep });
			await toStep('1234', '1234');
			makeEl().click();
			await until(() => seams.card !== null, 'the backup card');
			view.unmount();

			expect(calls).toEqual(['up', 'down']);
		});

		it('keeps the card, and says nothing more, through a switch away', async () => {
			await mount({}, { onbackupstep });
			await toStep('1234', '1234');
			makeEl().click();
			await until(() => seams.card !== null, 'the backup card');
			relockEachSync(relockables, 'hygiene');
			await real(50);

			expect(calls).toEqual(['up']);
		});
	});

	// A backup begun at setup must not carry on into PIN mode, where making one asks for the PIN: the turn-on ends it.
	it.each([
		['with nothing else going on', false],
		['with a switch away during the move, which leaves a card holding its session', true]
	])('ends the setup backup session when the PIN turns on, %s', async (_what, awayDuringMove) => {
		app.store = {};
		if (awayDuringMove) {
			rotate.mockImplementation(async () => {
				relockEachSync(relockables, 'hygiene');
				return { session: await fakeSession(), packHadFiles: false };
			});
		}
		await toCard();
		await expect.element(page.getByRole('button', { name: 'Show my passphrase' })).toBeVisible();
		expect(backupSession.active).toBe(true);

		skipEl().click();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');
		await real(100);

		expect(backupSession.active).toBe(false);
		// With the PIN on, making a backup begins on the PIN step, not on the words.
		await render(BackupCard, { props: { db, onEraseRequest: () => {} } });
		await page.getByRole('button', { name: 'Make a backup', exact: true }).click();
		await expect
			.element(page.getByLabelText('Enter your current PIN', { exact: true }))
			.toBeVisible();
		expect(page.getByRole('button', { name: 'Show my passphrase' }).query()).toBeNull();
		expect(backupSession.active).toBe(false);
	});

	// While the records move, the step's card is gone with its open control, so no export can start inside the move.
	describe('while the records move', () => {
		let release: () => void;
		beforeEach(() => {
			const gate = new Promise<void>((resolve) => (release = resolve));
			rotate.mockImplementation(async () => {
				await gate;
				// A switch away during the move: a session still open would be left concealed, not cleared.
				relockEachSync(relockables, 'hygiene');
				return { session: await fakeSession(), packHadFiles: false };
			});
		});

		async function skipIntoTheMove(): Promise<void> {
			app.store = {};
			await toCard();
			await expect.element(page.getByRole('button', { name: 'Show my passphrase' })).toBeVisible();
			skipEl().click();
			await until(() => rotate.mock.calls.length > 0, 'the move started');
		}

		it("takes the step's card, and with it the control that would open an export", async () => {
			await skipIntoTheMove();

			expect(document.querySelector('#backup-toggle-export')).toBeNull();
			expect(backupSession.active).toBe(false);
			release();
			await until(() => summary() === 'PIN on', 'the row reading PIN on');
		});

		it('leaves no export running in PIN mode, whatever was pressed on the card during the move', async () => {
			await skipIntoTheMove();
			document.querySelector<HTMLElement>('#backup-toggle-export')?.click();
			await real(50);
			release();
			await until(() => summary() === 'PIN on', 'the row reading PIN on');
			await real(100);

			expect(backupSession.active).toBe(false);
		});
	});

	// An export opened on the page's own card while the PIN was off is no more welcome in PIN mode than one begun in the step.
	it("ends an export opened on the page's own card when the PIN turns on from Skip", async () => {
		app.store = {};
		await mount();
		await toStep('1234', '1234');
		await render(BackupCard, { props: { db, onEraseRequest: () => {} } });
		await page.getByRole('button', { name: 'Make a backup', exact: true }).click();
		await expect.element(page.getByRole('button', { name: 'Show my passphrase' })).toBeVisible();
		expect(backupSession.active).toBe(true);

		skipEl().click();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');
		await real(100);

		expect(backupSession.active).toBe(false);
		expect(page.getByRole('button', { name: 'Show my passphrase' }).query()).toBeNull();
		await expect
			.element(page.getByRole('button', { name: 'Make a backup', exact: true }))
			.toHaveAttribute('aria-expanded', 'false');
	});

	// The turn-on takes the keystore lock and moves every record: while a backup is being made from them, it waits.
	it.each([
		'picking-save',
		'save-chosen',
		'replace-warning',
		'deriving',
		'snapshot',
		'encrypting',
		'verifying',
		'writing'
	] as const)(
		'holds Skip and turn on off while the backup is in its %s phase, and frees it when the run ends',
		async (phase) => {
			app.store = {};
			await toCard();
			await expect.element(page.getByRole('button', { name: 'Show my passphrase' })).toBeVisible();
			expect((skipEl() as HTMLButtonElement).disabled).toBe(false);

			backupSession.enterPhase(phase);
			await until(() => (skipEl() as HTMLButtonElement).disabled, 'Skip held off');
			skipEl().click();
			await real(100);
			expect(rotate).not.toHaveBeenCalled();
			expect(summary()).toBe('Off');

			backupSession.cancel();
			await until(() => !(skipEl() as HTMLButtonElement).disabled, 'Skip free again');
			skipEl().click();
			await until(() => summary() === 'PIN on', 'the row reading PIN on');
			expect(rotate).toHaveBeenCalledTimes(1);
		}
	);

	// The setup's backup runs while the PIN is still off, so it is never asked for a PIN it does not have yet.
	it('asks for no PIN inside the step: the card opens on the words', async () => {
		app.store = {};
		await toCard();

		await expect.element(page.getByRole('button', { name: 'Show my passphrase' })).toBeVisible();
		expect(page.getByLabelText('Enter your current PIN').query()).toBeNull();
		expect(backupSession.kind).toBe('export');
		expect(app.keyMode).toBe('local');
	});
});

describe('held keys', () => {
	async function hold(repeats = 10): Promise<void> {
		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		for (let i = 0; i < repeats; i += 1) {
			await real(40);
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
		}
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await real(50);
	}

	// Opening hands focus to the first field during the press, so the key's repeats must not press anything there.
	it('opens once for an Enter held on the toggle, with the cursor in the first field', async () => {
		await mount();
		let flips = 0;
		const watch = new MutationObserver((records) => (flips += records.length));
		watch.observe(toggleEl(), { attributes: true, attributeFilter: ['aria-expanded'] });
		toggleEl().focus();
		await hold();
		watch.disconnect();

		expect(flips).toBe(1);
		expect(expanded()).toBe(true);
		expect(document.activeElement).toBe(firstEl());
		expect(alertText()).toBeNull();
	});

	// The step hands focus to its first button, which is where the key's repeats then land: they must not press it.
	it('shows the backup step once for an Enter held on Next, and the repeats that follow press nothing on it', async () => {
		derive.mockImplementation(async () => {
			await real(100);
			return { macKey, kek };
		});
		await mount();
		await openRow();
		await fill('1234', '1234');
		nextEl().focus();
		await hold();

		expect(derive).toHaveBeenCalledTimes(1);
		expect(hasStep()).toBe(true);
		expect(document.activeElement).toBe(makeEl());
		expect(seams.card).toBeNull();
		expect(rotate).not.toHaveBeenCalled();
		expect(summary()).toBe('Off');
	});

	// A turn-on that works hands focus to the toggle, which is where the key's repeats then land: they must not close it.
	it('turns on once for an Enter held on Skip and turn on, and the repeats that follow do not close the row', async () => {
		derive.mockImplementation(async () => {
			await real(100);
			return { macKey, kek };
		});
		await mount();
		await toStep('1234', '1234');
		skipEl().focus();
		await hold();

		expect(derive).toHaveBeenCalledTimes(1);
		expect(rotate).toHaveBeenCalledTimes(1);
		expect(summary()).toBe('PIN on');
		expect(expanded()).toBe(true);
		expect(hasText(PIN_ON_LINE)).toBe(true);
	});

	// Make a backup and turn on hands focus to the card it mounts: the repeats must neither press Skip nor turn anything on.
	it('mounts the card once for an Enter held on Make a backup and turn on, and turns nothing on', async () => {
		await mount();
		await toStep('1234', '1234');
		makeEl().focus();
		await hold();

		expect(seams.card).not.toBeNull();
		expect(rotate).not.toHaveBeenCalled();
		expect(summary()).toBe('Off');
	});

	// Next keeps focus after a failure; its repeats would press it again over the emptied fields and replace the answer.
	it('keeps the line a failed Next ended with, for an Enter held on it', async () => {
		derive.mockImplementation(async () => {
			await real(100);
			throw new PinNoMemoryError();
		});
		await mount();
		await openRow();
		await fill('1234', '1234');
		nextEl().focus();
		await hold();

		expect(derive).toHaveBeenCalledTimes(1);
		expect(alertText()).toBe(LOW_MEMORY_LINE);
	});

	// Cancel hands focus to the toggle, which is where the key's repeats then land: they must not open the row again.
	it('closes once for an Enter held on Cancel, and the repeats that follow do not open it again', async () => {
		await mount();
		await openRow();
		cancelEl().focus();
		await hold();

		expect(expanded()).toBe(false);
		expect(document.activeElement).toBe(toggleEl());
	});

	describe('with the PIN on', () => {
		beforeEach(async () => {
			await pinOn();
			deriveByPin();
		});

		// Opening hands focus to the first field during the press, so the key's repeats must not press anything there.
		it.each(['Change PIN', 'Remove PIN'] as const)(
			'opens the form once for an Enter held on %s, with the cursor in its first field',
			async (name) => {
				await mount();
				await openRow();
				buttonEl(name).focus();
				await hold();

				expect(inForm()).toBe(true);
				expect(document.activeElement).toBe(currentEl());
				expect(alertText()).toBeNull();
				expect(derive).not.toHaveBeenCalled();
			}
		);

		// The form's own button is gone once it works, and focus is on the toggle: the repeats there must not open the row.
		it.each([
			['Change PIN', 2],
			['Remove PIN', 1]
		] as const)(
			'works once for an Enter held on %s, and the repeats that follow do not open the row',
			async (name, derives) => {
				derive.mockImplementation(async (pin: string) => {
					if (pin === CURRENT) {
						await real(100);
						return { macKey, kek };
					}
					return newKeys;
				});
				await mount();
				await openForm(name);
				await currentField().fill(CURRENT);
				if (name === 'Change PIN') {
					await firstField().fill(NEW_PIN);
					await secondField().fill(NEW_PIN);
				}
				buttonEl(name).focus();
				await hold();

				expect(derive).toHaveBeenCalledTimes(derives);
				expect(name === 'Change PIN' ? rotate : remove).toHaveBeenCalledTimes(1);
				expect(statusLines()).toEqual([name === 'Change PIN' ? CHANGED_LINE : REMOVED_LINE]);
				expect(expanded()).toBe(false);
				expect(document.activeElement).toBe(toggleEl());
			}
		);

		// The primary keeps focus after a failure; its repeats would press it again over the emptied fields and replace the answer.
		it.each(['Change PIN', 'Remove PIN'] as const)(
			'keeps the line a failed %s ended with, for an Enter held on it',
			async (name) => {
				derive.mockImplementation(async () => {
					await real(100);
					throw new PinNoMemoryError();
				});
				await mount();
				await openForm(name);
				await currentField().fill(CURRENT);
				if (name === 'Change PIN') {
					await firstField().fill(NEW_PIN);
					await secondField().fill(NEW_PIN);
				}
				buttonEl(name).focus();
				await hold();

				expect(derive).toHaveBeenCalledTimes(1);
				expect(alertText()).toBe(CHECK_LOW_MEMORY_LINE);
			}
		);

		// Cancel hands focus back to the button that opened the form, which is where the key's repeats then land.
		it.each(['Change PIN', 'Remove PIN'] as const)(
			'closes the %s form once for an Enter held on Cancel, and the repeats that follow do not open it again',
			async (name) => {
				await mount();
				await openForm(name);
				cancelEl().focus();
				await hold();

				expect(inForm()).toBe(false);
				expect(hasText(PIN_ON_LINE)).toBe(true);
				expect(document.activeElement).toBe(buttonEl(name));
			}
		);
	});
});

describe('the row with the PIN on', () => {
	beforeEach(async () => {
		await pinOn();
		deriveByPin();
	});

	// A live region has to be in the page before its text arrives, or a screen reader may not speak the text.
	it('keeps the status region on the page, shown, before there is anything to say', async () => {
		await mount();

		const region = document.querySelector('[role="status"]');
		expect(region).not.toBeNull();
		expect(region ? getComputedStyle(region).display : 'missing').not.toBe('none');
		expect(statusLines()).toEqual([]);
	});

	it('offers Change PIN and Remove PIN under the PIN-on line', async () => {
		await mount();
		await openRow();

		expect(hasText(PIN_ON_LINE)).toBe(true);
		expect(hasButton('Change PIN')).toBe(true);
		expect(hasButton('Remove PIN')).toBe(true);
		expect(summary()).toBe('PIN on');
	});

	it('opens the Change form: the current PIN, the new PIN twice, then Change PIN and Cancel', async () => {
		await mount();
		await openForm('Change PIN');

		const labels = [...document.querySelectorAll('label')].map((l) => l.textContent?.trim());
		expect(labels).toEqual(['Enter your current PIN', 'Choose a 4-6 digit PIN', 'Enter it again']);
		expect(currentEl().type).toBe('password');
		expect(hasButton('Change PIN')).toBe(true);
		expect(cancelEl()).not.toBeNull();
		expect(hasButton('Remove PIN')).toBe(false);
	});

	it('opens the Remove form: the question, what it does, the current PIN, then Remove PIN and Cancel', async () => {
		await mount();
		await openForm('Remove PIN');

		expect(hasText('Remove your PIN?')).toBe(true);
		expect(hasText(REMOVE_HINT)).toBe(true);
		const labels = [...document.querySelectorAll('label')].map((l) => l.textContent?.trim());
		expect(labels).toEqual(['Enter your current PIN']);
		expect(hasButton('Remove PIN')).toBe(true);
		expect(cancelEl()).not.toBeNull();
		expect(hasButton('Change PIN')).toBe(false);
	});

	// Both need the saved data open, so a locked screen has the line and nothing to press.
	it('is the PIN-on line alone while the app is locked', async () => {
		app.pinLocked = true;
		await mount();
		await openRow();

		expect(hasText(PIN_ON_LINE)).toBe(true);
		expect(hasButton('Change PIN')).toBe(false);
		expect(hasButton('Remove PIN')).toBe(false);
	});

	// A Lock while a typed PIN sits in a field must not leave it there for the next person.
	it.each(['Change PIN', 'Remove PIN'] as const)(
		'empties every field of the %s form when the app relocks',
		async (name) => {
			await mount();
			await openForm(name);
			await currentField().fill(CURRENT);
			if (name === 'Change PIN') {
				await firstField().fill(NEW_PIN);
				await secondField().fill(NEW_PIN);
			}
			relockEachSync(relockables, 'user');

			await until(() => fieldsEmpty(), 'every field empty');
			expect(document.querySelectorAll('input')).toHaveLength(name === 'Change PIN' ? 3 : 1);
		}
	);
});

describe('changing the PIN', () => {
	beforeEach(async () => {
		await pinOn();
		deriveByPin();
	});

	describe('the checks, and what each one costs', () => {
		it('counts a wrong current PIN before it is derived, says it is not right for tries 1 to 3, then owes a wait', async () => {
			await mount();
			await openForm('Change PIN');

			for (const tries of [1, 2, 3]) {
				await pressChange(WRONG, NEW_PIN, NEW_PIN);
				expect(alertText()).toBe(NOT_RIGHT_LINE);
				// The try was on the row when the derive ran, not after.
				expect(deriveLog.at(-1)?.tries).toMatchObject({ count: tries, pending: true });
			}
			await pressChange(WRONG, NEW_PIN, NEW_PIN);
			expect(alertText()).toBe(waitLine(30_000));

			// A press while the wait is owed is answered from the row: nothing is derived and no try is added.
			const derives = deriveLog.length;
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);
			expect(alertText()).toBe(waitLine(30_000));
			expect(deriveLog).toHaveLength(derives);
			expect(await readTries(db)).toMatchObject({ count: 4, waitMs: 30_000 });
			expect(rotate).not.toHaveBeenCalled();
		});

		// The wait is only on the row until something counts it down, and nothing else does while the person is in Settings.
		it('counts an owed wait down while the row is up, so the right PIN works once it is over', async () => {
			await mount();
			await openForm('Change PIN');
			for (let tries = 0; tries < 4; tries += 1) await pressChange(WRONG, NEW_PIN, NEW_PIN);
			expect(alertText()).toBe(waitLine(30_000));

			clock.t += 30_000;
			runWaitClock?.();
			await until(async () => (await readTries(db)).waitMs === 0, 'the wait written down');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);

			await until(() => rotate.mock.calls.length === 1, 'the change');
		});

		// The stored remainder is written every few seconds, so it runs behind the clock: a press that restarted the count
		// from it would push the end of the wait away and show a wait longer than the one left.
		it('answers a press while the wait is owed with the time left on the running count, not the stored one', async () => {
			await mount();
			await openForm('Change PIN');
			for (let tries = 0; tries < 4; tries += 1) await pressChange(WRONG, NEW_PIN, NEW_PIN);

			clock.t += 10_000;
			runWaitClock?.();
			await until(async () => (await readTries(db)).waitMs === 20_000, 'the remainder written');
			clock.t += 4_000;
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);

			expect(alertText()).toBe(waitLine(16_000));
			expect(deriveLog).toHaveLength(4);
		});

		// Nothing else counts the wait down for a person in Settings, so the line has to: it shows the time that is left.
		it('shows the time left on the wait line each second, and takes the line away at zero', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			await mount();
			await openForm('Change PIN');
			for (let tries = 0; tries < 4; tries += 1) await pressChange(WRONG, NEW_PIN, NEW_PIN);
			expect(alertText()).toBe(waitLine(30_000));

			clock.t += 1_000;
			vi.advanceTimersByTime(1_000);
			await tick();
			expect(alertText()).toBe(waitLine(29_000));
			clock.t += 29_000;
			vi.advanceTimersByTime(29_000);
			await tick();
			expect(alertText()).toBeNull();
		});

		// A line that took the wait's place (the new PIN was not 4 to 6 digits) is the person's to read, not the count's.
		it('leaves a line that replaced the wait line alone as the count runs on', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			await mount();
			await openForm('Change PIN');
			for (let tries = 0; tries < 4; tries += 1) await pressChange(WRONG, NEW_PIN, NEW_PIN);
			await pressChange(CURRENT, '123', '123');
			expect(alertText()).toBe(FORMAT_LINE);

			clock.t += 5_000;
			vi.advanceTimersByTime(5_000);
			await tick();
			expect(alertText()).toBe(FORMAT_LINE);
			clock.t += 25_000;
			vi.advanceTimersByTime(25_000);
			await tick();
			expect(alertText()).toBe(FORMAT_LINE);
		});

		it('says the memory ran out, and takes the try back, when the current PIN could not be checked', async () => {
			derive.mockRejectedValue(new PinNoMemoryError());
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);

			expect(alertText()).toBe(CHECK_LOW_MEMORY_LINE);
			expect(await readTries(db)).toMatchObject({ count: 0, pending: false });
			expect(rotate).not.toHaveBeenCalled();
		});

		it.each([
			['a new PIN that is not 4 to 6 digits', CURRENT, '123', '123', FORMAT_LINE],
			['two new PINs that differ', CURRENT, NEW_PIN, '5679', MISMATCH_LINE],
			['a current PIN that is not 4 to 6 digits', '12', NEW_PIN, NEW_PIN, NOT_RIGHT_LINE]
		])('with %s: says so before any try or derive', async (_what, current, next, again, line) => {
			await mount();
			await openForm('Change PIN');
			await pressChange(current, next, again);

			expect(alertText()).toBe(line);
			expect(deriveLog).toHaveLength(0);
			expect(await readTries(db)).toMatchObject({ count: 0 });
			expect(rotate).not.toHaveBeenCalled();
		});

		// The new PIN's derive follows the setup's rule on a cold, visible page.
		it.each([
			[5_000, true],
			[5_001, false]
		])('with a derive of the new PIN of %i ms, the PIN changes: %s', async (ms, changes) => {
			deriveByPin(ms);
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);

			await until(() => alertText() !== null || statusLines().length > 0, 'a result');
			if (changes) {
				expect(rotate).toHaveBeenCalledTimes(1);
				expect(statusLines()).toEqual([CHANGED_LINE]);
			} else {
				expect(alertText()).toBe(LOW_MEMORY_LINE);
				expect(rotate).not.toHaveBeenCalled();
			}
		});

		it('keeps the PIN, and says why, when the phone has no memory for the new PIN', async () => {
			derive.mockImplementation(async (pin: string) => {
				if (pin === CURRENT) return { macKey, kek };
				throw new PinNoMemoryError();
			});
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);

			expect(alertText()).toBe(LOW_MEMORY_LINE);
			expect(rotate).not.toHaveBeenCalled();
		});

		it('writes nothing, and adds no line, when the page was hidden during the new PIN derive', async () => {
			derive.mockImplementation(async (pin: string) => {
				if (pin === CURRENT) return { macKey, kek };
				vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
				document.dispatchEvent(new Event('visibilitychange'));
				return newKeys;
			});
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);

			expect(rotate).not.toHaveBeenCalled();
			expect(alertText()).toBeNull();
			expect(statusLines()).toEqual([]);
		});
	});

	describe('when it works', () => {
		it('moves the records with the counter read just before and a new salt, then holds the new session and tells the other tabs', async () => {
			await bumpCounter(db);
			const counterBefore = await readCounter(db);
			const stored = (await readPinRowAndCounter(db)).row as unknown as KeystoreRecordPin;
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);
			await until(() => statusLines().length > 0, 'the status line');

			expect(rotate).toHaveBeenCalledTimes(1);
			const [, input] = rotate.mock.calls[0] as unknown as [
				IDBDatabase,
				{ macKey: CryptoKey; kek: CryptoKey; salt: Uint8Array; kdf: unknown; counterBefore: number }
			];
			expect(input).toMatchObject({ ...newKeys, kdf: KDF_V1, counterBefore });
			expect(input.salt).toHaveLength(16);
			expect([...input.salt]).not.toEqual([...stored.salt]);
			expect(app.publish).toHaveBeenCalledTimes(1);
			expect(app.publish).toHaveBeenCalledWith({ type: 'keys-changed' });
			expect(app.keyMode).toBe('pin');
			expect(getSession()).not.toBeNull();
			expect(statusLines()).toEqual([CHANGED_LINE]);
			expect(alertText()).toBeNull();
			expect(expanded()).toBe(false);
			// The pressed button is gone with the form; the person is not dropped back at the top of the page.
			await until(() => document.activeElement === toggleEl(), 'focus back on the toggle');
		});

		// Between the move and the session no task may run: the old keys are gone and the new ones are not yet held.
		it('holds the session in the same microtask as the move resolves', async () => {
			rotate.mockImplementation(async () => {
				const session = await fakeSession();
				realSetTimeout(() => seams.events.push('task'), 0);
				return { session, packHadFiles: false };
			});
			seams.events.length = 0;
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);
			await until(() => seams.events.includes('task'), 'the next task');

			expect(seams.events).toEqual(['setSession', 'task']);
		});

		it.each([
			[true, [CHANGED_LINE, PACK_LINE]],
			[false, [CHANGED_LINE]]
		])('with a pack that held files: %s, the status lines are %j', async (had, lines) => {
			rotate.mockImplementation(async () => ({ session: await fakeSession(), packHadFiles: had }));
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);
			await until(() => statusLines().length > 0, 'the status line');

			expect(statusLines()).toEqual(lines);
		});
	});

	describe('when it does not', () => {
		const NAMES = [
			['profile', 'profile'],
			['timeline-state', 'timeline'],
			['calendar-sync', 'calendar settings'],
			['byok', 'API key'],
			['skillbridge-finder', 'SkillBridge saves']
		] as const;

		async function failsWith(line: string): Promise<void> {
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);
			await until(() => alertText() !== null, 'a line');

			expect(alertText()).toBe(line);
			expect(statusLines()).toEqual([]);
			expect(summary()).toBe('PIN on');
			expect(app.keyMode).toBe('pin');
			expect(getSession()).toBeNull();
			expect(seams.events).toEqual([]);
			expect(app.publish).not.toHaveBeenCalled();
			expect(fieldsEmpty()).toBe(true);
		}

		it.each(NAMES)('names the %s store that would not open, as "%s"', async (store, name) => {
			rotate.mockRejectedValue(new RotationStoreError(store));
			await failsWith(CHANGE_STORE_LINE(name));
		});

		it.each([
			['the lock moved meanwhile', new Error('E_ROTATE_MOVED')],
			['the keystore lock was busy', new LockAcquisitionTimeout()],
			['anything else', new Error('E_ROTATE_WRITE')]
		])('says to try again when %s', async (_name, error) => {
			rotate.mockRejectedValue(error);
			await failsWith(CHANGE_FAILED_LINE);
		});

		// The lock was taken off in another tab while this form was open: there is no PIN row to check against.
		it('says to try again, and counts nothing, when the row is no longer a PIN row', async () => {
			await deleteTestDb(db);
			db = await openTestDb();
			app.db = db;
			await bootstrapLocalKeystore(db);
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);

			expect(alertText()).toBe(CHANGE_FAILED_LINE);
			expect(await readTries(db)).toMatchObject({ count: 0 });
			expect(deriveLog).toHaveLength(0);
			expect(rotate).not.toHaveBeenCalled();
		});
	});

	describe('a Lock while it works', () => {
		it.each(['user', 'idle', 'peer'] as const)(
			'writes nothing, and says nothing, when a %s lock lands while the current PIN is checked',
			async (reason) => {
				derive.mockImplementation(async () => {
					relockEachSync(relockables, reason);
					return { macKey, kek };
				});
				await mount();
				await openForm('Change PIN');
				await pressChange(CURRENT, NEW_PIN, NEW_PIN);
				await real(100);

				// A locked tab does not go on to derive the new PIN.
				expect(derive).toHaveBeenCalledTimes(1);
				expect(rotate).not.toHaveBeenCalled();
				expect(app.publish).not.toHaveBeenCalled();
				expect(getSession()).toBeNull();
				expect(alertText()).toBeNull();
				expect(statusLines()).toEqual([]);
			}
		);

		it('writes nothing, and says nothing, when a Lock lands while the new PIN is derived', async () => {
			derive.mockImplementation(async (pin: string) => {
				if (pin === NEW_PIN) relockEachSync(relockables, 'user');
				return pin === NEW_PIN ? newKeys : { macKey, kek };
			});
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);
			await real(100);

			expect(rotate).not.toHaveBeenCalled();
			expect(app.publish).not.toHaveBeenCalled();
			expect(alertText()).toBeNull();
		});

		// The move may already have committed: this tab was locked before it could hold the new keys.
		it('holds no session, and shows the PIN lock, when a Lock lands during the move', async () => {
			rotate.mockImplementation(async () => {
				relockEachSync(relockables, 'user');
				return { session: await fakeSession(), packHadFiles: false };
			});
			seams.events.length = 0;
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);
			await until(() => app.publish.mock.calls.length > 0, 'the signal');

			expect(getSession()).toBeNull();
			expect(seams.events).toEqual([]);
			expect(app.pinLocked).toBe(true);
			expect(app.keyMode).toBe('pin');
			expect(app.publish).toHaveBeenCalledTimes(1);
			expect(app.publish).toHaveBeenCalledWith({ type: 'keys-changed' });
		});

		// A switch away locks nothing: during the move it changes nothing.
		it('changes as usual when a switch away lands during the move', async () => {
			rotate.mockImplementation(async () => {
				relockEachSync(relockables, 'hygiene');
				return { session: await fakeSession(), packHadFiles: false };
			});
			await mount();
			await openForm('Change PIN');
			await pressChange(CURRENT, NEW_PIN, NEW_PIN);
			await until(() => statusLines().length > 0, 'the status line');

			expect(getSession()).not.toBeNull();
			expect(app.pinLocked).toBe(false);
		});
	});
});

describe('removing the PIN', () => {
	beforeEach(async () => {
		await pinOn();
		deriveByPin();
	});

	it('counts a wrong current PIN before it is derived, and removes nothing', async () => {
		await mount();
		await openForm('Remove PIN');
		await pressRemove(WRONG);

		expect(alertText()).toBe(NOT_RIGHT_LINE);
		expect(deriveLog).toHaveLength(1);
		expect(deriveLog[0]?.tries).toMatchObject({ count: 1, pending: true });
		expect(remove).not.toHaveBeenCalled();
		expect(app.keyMode).toBe('pin');
	});

	it('says the memory ran out, and takes the try back, when the current PIN could not be checked', async () => {
		derive.mockRejectedValue(new PinNoMemoryError());
		await mount();
		await openForm('Remove PIN');
		await pressRemove(CURRENT);

		expect(alertText()).toBe(CHECK_LOW_MEMORY_LINE);
		expect(await readTries(db)).toMatchObject({ count: 0, pending: false });
		expect(remove).not.toHaveBeenCalled();
	});

	it('removes with the session the current PIN opened and the counter read just before, then reads Off and tells the other tabs', async () => {
		await bumpCounter(db);
		const { row, counter } = await readPinRowAndCounter(db);
		await mount();
		await openForm('Remove PIN');
		await pressRemove(CURRENT);
		await until(() => statusLines().length > 0, 'the status line');

		expect(derive).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
		const [, input] = remove.mock.calls[0] as unknown as [
			IDBDatabase,
			{ session: KeySession; counterBefore: number }
		];
		expect(input.counterBefore).toBe(counter);
		expect(input.session.identity).toMatchObject({
			v: 1,
			keystoreGeneration: row?.keystoreGeneration,
			epoch: row?.epoch
		});
		expect(app.keyMode).toBe('local');
		expect(app.publish).toHaveBeenCalledTimes(1);
		expect(app.publish).toHaveBeenCalledWith({ type: 'keys-changed' });
		expect(statusLines()).toEqual([REMOVED_LINE]);
		expect(summary()).toBe('Off');
		expect(expanded()).toBe(false);
		await until(() => document.activeElement === toggleEl(), 'focus back on the toggle');
		// This tab stays unlocked: removing shows no lock.
		expect(app.pinLocked).toBe(false);
	});

	it.each([
		['the lock moved meanwhile', new Error('E_ROTATE_MOVED')],
		['the keystore lock was busy', new LockAcquisitionTimeout()],
		['anything else', new Error('E_ROTATE_WRITE')]
	])('says to try again, and keeps the PIN, when %s', async (_name, error) => {
		remove.mockRejectedValue(error);
		await mount();
		await openForm('Remove PIN');
		await pressRemove(CURRENT);
		await until(() => alertText() !== null, 'a line');

		expect(alertText()).toBe(REMOVE_FAILED_LINE);
		expect(statusLines()).toEqual([]);
		expect(app.keyMode).toBe('pin');
		expect(summary()).toBe('PIN on');
		expect(app.publish).not.toHaveBeenCalled();
		expect(fieldsEmpty()).toBe(true);
	});

	it('says to try again, and counts nothing, when the row is no longer a PIN row', async () => {
		await deleteTestDb(db);
		db = await openTestDb();
		app.db = db;
		await bootstrapLocalKeystore(db);
		await mount();
		await openForm('Remove PIN');
		await pressRemove(CURRENT);

		expect(alertText()).toBe(REMOVE_FAILED_LINE);
		expect(await readTries(db)).toMatchObject({ count: 0 });
		expect(remove).not.toHaveBeenCalled();
	});

	it.each(['user', 'idle', 'peer'] as const)(
		'writes nothing, and says nothing, when a %s lock lands while the current PIN is checked',
		async (reason) => {
			derive.mockImplementation(async () => {
				relockEachSync(relockables, reason);
				return { macKey, kek };
			});
			await mount();
			await openForm('Remove PIN');
			await pressRemove(CURRENT);
			await real(100);

			expect(remove).not.toHaveBeenCalled();
			expect(app.publish).not.toHaveBeenCalled();
			expect(alertText()).toBeNull();
			expect(statusLines()).toEqual([]);
			expect(app.keyMode).toBe('pin');
		}
	);

	// The commit may have landed: the other tabs must hear of it, and this one stays locked as the Lock left it.
	it('tells the other tabs, and stays locked on the PIN card, when a Lock lands during the removal', async () => {
		remove.mockImplementation(async () => {
			relockEachSync(relockables, 'user');
		});
		await mount();
		await openForm('Remove PIN');
		await pressRemove(CURRENT);
		await until(() => app.publish.mock.calls.length > 0, 'the signal');

		expect(app.publish).toHaveBeenCalledTimes(1);
		expect(app.publish).toHaveBeenCalledWith({ type: 'keys-changed' });
		expect(app.keyMode).toBe('pin');
	});
});

describe('what a good current PIN says about the tries before it', () => {
	const SINCE = 'since your last unlock.';
	const putTries = (tries: TriesState) =>
		withStores(db, 'app-lock', 'readwrite', (tx) => {
			tx.objectStore('app-lock').put({ id: 'tries', ...tries });
		});

	beforeEach(async () => {
		await pinOn();
		deriveByPin();
	});

	it('shows the wrong tries between the changed line and the offline listings line', async () => {
		rotate.mockResolvedValue({ session: await fakeSession(), packHadFiles: true });
		await mount();
		await openForm('Change PIN');
		await pressChange(WRONG, NEW_PIN, NEW_PIN);
		await pressChange(WRONG, NEW_PIN, NEW_PIN);
		await pressChange(CURRENT, NEW_PIN, NEW_PIN);
		await until(() => statusLines().length > 0, 'the status lines');

		expect(statusLines()).toEqual([CHANGED_LINE, `2 wrong PIN tries ${SINCE}`, PACK_LINE]);
	});

	it('shows a try that did not finish after the removed line', async () => {
		await putTries({ count: 1, waitMs: 0, pending: true });
		await mount();
		await openForm('Remove PIN');
		await pressRemove(CURRENT);
		await until(() => statusLines().length > 0, 'the status lines');

		expect(statusLines()).toEqual([REMOVED_LINE, 'One PIN try did not finish.']);
	});

	// The tries are said as soon as the PIN is good, so a failure later in the same press does not take them away.
	it('keeps them under the line of a press that fails after the PIN was good', async () => {
		deriveByPin(5_001);
		await putTries({ count: 1, waitMs: 0, pending: false });
		await mount();
		await openForm('Change PIN');
		await pressChange(CURRENT, NEW_PIN, NEW_PIN);
		await until(() => alertText() !== null, 'a line');

		expect(alertText()).toBe(LOW_MEMORY_LINE);
		expect(statusLines()).toEqual([`1 wrong PIN try ${SINCE}`]);
	});
});

describe('with the real moves of the records', () => {
	// The one place the pieces run together: a device built as a person builds it, turned on through the row, and then
	// a reload (the session gone) that cannot read the profile without the PIN.
	it('turns a local device onto a PIN and leaves its profile unreadable without the session', async () => {
		await bootstrapLocalKeystore(db);
		await createProfileStore(db).save({
			setupIntent: 'completed',
			eaos: encodeEaos(parseEaosAtRead('2027-04-15')),
			yearsOfService: 4
		});
		// Stands in for the PIN step with fixed key bytes: the derive's own Argon2id is the worker's, not this test's.
		const fixedMac = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), HMAC, false, [
			'sign',
			'verify'
		]);
		const fixedKek = await crypto.subtle.importKey(
			'raw',
			new Uint8Array(32).fill(9),
			{ name: 'AES-KW' },
			false,
			['wrapKey', 'unwrapKey']
		);
		await render(AppLockRow, {
			props: { deps: { derive: async () => ({ macKey: fixedMac, kek: fixedKek }) } }
		});
		await openRow();
		await fill('1234', '1234');
		nextEl().click();
		await until(() => hasStep(), 'the backup step');
		skipEl().click();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');

		expect(getSession()).not.toBeNull();
		dropSession();
		await expect(createProfileStore(db).load()).rejects.toBeInstanceOf(KeystoreLockedError);
	});

	// Turn on, change, remove: each step through the row and the real moves, with a PIN's keys fixed by its digits.
	it('changes the PIN so only the new one opens the profile, then removes it so no session is needed', async () => {
		await bootstrapLocalKeystore(db);
		await createProfileStore(db).save({
			setupIntent: 'completed',
			eaos: encodeEaos(parseEaosAtRead('2027-04-15')),
			yearsOfService: 4
		});
		const old = await fixedKeys(7);
		const next = await fixedKeys(11);
		const keysOf: Record<string, { macKey: CryptoKey; kek: CryptoKey }> = {
			[CURRENT]: old,
			[NEW_PIN]: next
		};
		await render(AppLockRow, {
			props: {
				deps: {
					derive: async (pin) => {
						const keys = keysOf[pin];
						if (!keys) throw new Error('E_TEST_PIN');
						return keys;
					}
				}
			}
		});
		await openRow();
		await fill(CURRENT, CURRENT);
		nextEl().click();
		await until(() => hasStep(), 'the backup step');
		skipEl().click();
		await until(() => summary() === 'PIN on', 'the row reading PIN on');

		// Change: the old PIN is asked for, and the records move to the new one.
		buttonEl('Change PIN').click();
		await until(() => inForm(), 'the form');
		await pressChange(CURRENT, NEW_PIN, NEW_PIN);
		await until(() => statusLines().includes(CHANGED_LINE), 'the status line');
		const { row, counter } = await readPinRowAndCounter(db);
		const pinRow = row as unknown as KeystoreRecordPin;
		await expect(openPinSession(pinRow, old, counter)).rejects.toBeInstanceOf(WrongPinError);
		dropSession();
		setSession(await openPinSession(pinRow, next, counter));
		expect((await createProfileStore(db).load())?.yearsOfService).toBe(4);

		// Remove: the new PIN is asked for, and the profile then opens with no session at all.
		await openRow();
		buttonEl('Remove PIN').click();
		await until(() => inForm(), 'the form');
		await pressRemove(NEW_PIN);
		await until(() => statusLines().includes(REMOVED_LINE), 'the status line');
		expect(getSession()).toBeNull();
		expect(summary()).toBe('Off');
		expect((await createProfileStore(db).load())?.yearsOfService).toBe(4);
	});
});

// Forced colors (Windows high contrast) repaint every colour from a small system palette and keep only borders and
// text: a filled button with no border becomes unmarked text.
describe('under forced colors', () => {
	it('the Next button keeps an outline', async () => {
		await mount();
		await openRow();
		const media = cdp();
		await media.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'forced-colors', value: 'active' }]
		});
		try {
			await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(true);
			const outline = getComputedStyle(nextEl());
			expect(outline.borderTopWidth).toBe('1px');
			expect(outline.borderTopStyle).toBe('solid');
		} finally {
			await media.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'none' }]
			});
		}
	});

	it('the Make a backup and turn on button keeps an outline', async () => {
		await mount();
		await toStep('1234', '1234');
		const media = cdp();
		await media.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'forced-colors', value: 'active' }]
		});
		try {
			await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(true);
			const outline = getComputedStyle(makeEl());
			expect(outline.borderTopWidth).toBe('1px');
			expect(outline.borderTopStyle).toBe('solid');
		} finally {
			await media.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'none' }]
			});
		}
	});

	it.each(['Change PIN', 'Remove PIN'] as const)('the %s button keeps an outline', async (name) => {
		await pinOn();
		await mount();
		await openForm(name);
		const media = cdp();
		await media.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'forced-colors', value: 'active' }]
		});
		try {
			await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(true);
			const outline = getComputedStyle(buttonEl(name));
			expect(outline.borderTopWidth).toBe('1px');
			expect(outline.borderTopStyle).toBe('solid');
		} finally {
			await media.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'none' }]
			});
		}
	});
});

// ---- the backup step, with the real card and the real moves --------------------------------------------------------------

const WORDS = ['bamboo', 'copper', 'harvest', 'lantern', 'oxygen', 'thimble'];

// The key worker's stand-in: the words, and a quick key for a derive (the real one is Argon2id in a worker).
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
		const material = await crypto.subtle.importKey('raw', message.pass, 'PBKDF2', false, [
			'deriveKey'
		]);
		const key = await crypto.subtle.deriveKey(
			{ name: 'PBKDF2', salt: message.salt, iterations: 1, hash: 'SHA-256' },
			material,
			{ name: 'AES-GCM', length: 256 },
			false,
			['encrypt', 'decrypt']
		);
		if (!this.#dead) this.onmessage?.({ data: { type: 'key', key } satisfies FromWorker });
	}
}

// A save place the person picked: it holds what was written, and reads it back.
function saveTarget(mangle = false): SaveHandle & { written: () => string } {
	let content = '';
	let staged = '';
	const writable: SaveWritable = {
		write: async (data) => {
			staged = data;
		},
		close: async () => {
			// A target that mangles the file: what it reads back is not what was written.
			content = staged + (mangle ? ' ' : '');
		},
		abort: () => Promise.resolve()
	};
	return {
		name: 'picked.json',
		getFile: () => Promise.resolve(new File([content], 'picked.json')),
		createWritable: async () => writable,
		written: () => content
	};
}

describe('the backup step, end to end', () => {
	it('makes the backup first, then turns the PIN on, and the Settings card reads the backup as current; the next backup asks for the PIN', async () => {
		await bootstrapLocalKeystore(db);
		const profile = createProfileStore(db);
		await profile.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		const target = saveTarget();
		const session = new BackupSession({
			isVisible: () => true,
			hasFocus: () => true,
			createWorker: () => new FakeKeyWorker()
		});
		seams.cardExtra = {
			session,
			exportDeps: { getSavePicker: () => async () => target, download: vi.fn(), readBackMs: 500 }
		};
		app.store = profile;
		try {
			// The real moves of the records; the derive answers with fixed keys instead of Argon2id.
			await mount({ rotate: rotateToPin });
			await toStep('1234', '1234');
			makeEl().click();
			await page.getByRole('button', { name: 'Show my passphrase' }).click();
			await page.getByLabelText('Passphrase', { exact: true }).fill(WORDS.join(' '));
			await page
				.getByRole('form', { name: 'Make a backup' })
				.getByRole('button', { name: 'Make a backup', exact: true })
				.click();

			// The file is written while the PIN is still off, and only then do the records move.
			await until(() => summary() === 'PIN on', 'the row reading PIN on', 10_000);
			expect(target.written()).toContain('"');
			expect(getSession()).not.toBeNull();
			const state = await readDeviceState(db);
			expect(state.mark).not.toBeNull();
			expect(state.mark?.gens).toStrictEqual(state.gens);

			// The Settings card, mounted after the turn-on, shows that backup as the last one.
			await render(BackupCard, { props: { db, onEraseRequest: () => {} } });
			const at = state.mark?.at ?? 0;
			await expect
				.element(page.getByText(lastBackupLine(formatBackupDate(at)), { exact: true }))
				.toBeVisible();

			// With the PIN on, a new backup begins on the PIN step.
			await page.getByRole('button', { name: 'Make a backup', exact: true }).click();
			await expect
				.element(page.getByLabelText('Enter your current PIN', { exact: true }))
				.toBeVisible();
			expect(session.phase).toBe('idle');
		} finally {
			session.relockSync('user');
			profile.relockSync('hygiene');
		}
	}, 30_000);

	// A file that does not read back whole may not open: the card says so and offers another, and nothing is turned on.
	it('does not turn the PIN on after a backup that does not read back whole, and leaves Skip to the person', async () => {
		await bootstrapLocalKeystore(db);
		const profile = createProfileStore(db);
		await profile.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		const session = new BackupSession({
			isVisible: () => true,
			hasFocus: () => true,
			createWorker: () => new FakeKeyWorker()
		});
		seams.cardExtra = {
			session,
			exportDeps: {
				getSavePicker: () => async () => saveTarget(true),
				download: vi.fn(),
				readBackMs: 500
			}
		};
		app.store = profile;
		try {
			await mount({ rotate: rotateToPin });
			await toStep('1234', '1234');
			makeEl().click();
			await page.getByRole('button', { name: 'Show my passphrase' }).click();
			await page.getByLabelText('Passphrase', { exact: true }).fill(WORDS.join(' '));
			await page
				.getByRole('form', { name: 'Make a backup' })
				.getByRole('button', { name: 'Make a backup', exact: true })
				.click();

			await expect.element(page.getByRole('button', { name: 'Make a new backup' })).toBeVisible();
			expect(hasText('the saved file does not match')).toBe(true);
			await real(200);
			expect(summary()).toBe('Off');
			expect(app.keyMode).toBe('local');
			expect(getSession()).toBeNull();
			expect(hasStep()).toBe(true);
			expect(skipEl()).not.toBeNull();
		} finally {
			session.relockSync('user');
			profile.relockSync('hygiene');
		}
	}, 30_000);
});
