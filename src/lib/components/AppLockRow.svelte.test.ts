import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cdp, page } from 'vitest/browser';
import AppLockRow, { type AppLockDeps } from './AppLockRow.svelte';
import { KDF_V1 } from '../backup/kdf-params';
import { LockAcquisitionTimeout } from '../db/locks';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
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
};

// Which tasks ran, in order, so a test can see that nothing ran between two of them.
const seams = vi.hoisted(() => ({ events: [] as string[], app: {} as Record<string, unknown> }));
vi.mock('$lib/profile/context', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/profile/context')>()),
	getProfileApp: () => seams.app
}));
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
	mode.value = 'local';
	relockables = [];
	app = {
		status: 'ready',
		db,
		joinRelock: createJoinRelock(relockables),
		publish: vi.fn(),
		pinLocked: false,
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
	vi.restoreAllMocks();
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

function mount(over: AppLockDeps = {}) {
	return render(AppLockRow, {
		props: {
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

		await until(() => alertText() !== null || summary() === 'PIN on', 'a result');
		if (turnsOn) {
			expect(summary()).toBe('PIN on');
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
		await submit('1234', '1234');
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
		await submit('1234', '1234');
		await until(() => seams.events.includes('task'), 'the next task');

		expect(seams.events).toEqual(['setSession', 'task']);
	});

	it.each([
		[true, true],
		[false, false]
	])('with a pack that held files: %s, the SkillBridge line shows: %s', async (had, shows) => {
		rotate.mockImplementation(async () => ({ session: await fakeSession(), packHadFiles: had }));
		await mount();
		await submit('1234', '1234');
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
		await submit('1234', '1234');
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
		await submit('1234', '1234');
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
		await submit('1234', '1234');
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

	// A turn-on that works hands focus to the toggle, which is where the key's repeats then land: they must not close it.
	it('turns on once for an Enter held on Next, and the repeats that follow do not close the row', async () => {
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
		expect(rotate).toHaveBeenCalledTimes(1);
		expect(summary()).toBe('PIN on');
		expect(expanded()).toBe(true);
		expect(hasText(PIN_ON_LINE)).toBe(true);
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
