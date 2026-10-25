import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cdp, page } from 'vitest/browser';
import AppLockRow, { type AppLockDeps } from './AppLockRow.svelte';
import { KDF_V1 } from '../backup/kdf-params';
import { LockAcquisitionTimeout } from '../db/locks';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { bumpCounter } from '../keystore/app-lock-store';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { PinNoMemoryError } from '../keystore/pin-derive';
import { RotationStoreError } from '../keystore/rotate';
import { dropSession, getSession, KeystoreLockedError, type KeySession } from '../keystore/session';
import { createJoinRelock, relockEachSync, type Relockable } from '../profile/app-init';
import { encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { createProfileStore } from '../profile/store.svelte';
import type { BusSignal } from '../broadcast/bus';

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
	clock = { t: 0 };
	derive = vi.fn(async () => ({ macKey, kek }));
	rotate = vi.fn(async () => ({ session: await fakeSession(), packHadFiles: false }));
});

afterEach(async () => {
	vi.restoreAllMocks();
	dropSession();
	await deleteTestDb(db);
});

function mount(over: AppLockDeps = {}) {
	return render(AppLockRow, {
		props: {
			deps: {
				derive: derive as unknown as AppLockDeps['derive'],
				rotate: rotate as unknown as AppLockDeps['rotate'],
				now: () => clock.t,
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
});
