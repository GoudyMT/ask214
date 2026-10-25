import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cdp, page } from 'vitest/browser';
import PinUnlock, { formatWait, type PinUnlockDeps } from './PinUnlock.svelte';
import { KDF_V1 } from '../backup/kdf-params';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { withStores } from '../db/schema';
import { readTries, type TriesState } from '../keystore/app-lock-store';
import { PinNoMemoryError } from '../keystore/pin-derive';
import { signKeystore, type KeystoreRecordPin } from '../keystore/record';
import { KeystoreHmacMismatchError } from '../keystore/read';
import { dropSession, getSession } from '../keystore/session';
import { readPinRowAndCounter } from '../keystore/unlock-row';
import { createJoinRelock, relockEachSync, type Relockable } from '../profile/app-init';

type TestApp = {
	status: 'ready';
	keyMode: 'pin';
	pinLocked: boolean;
	db: IDBDatabase;
	joinRelock: (r: Relockable) => () => void;
	unlockStores: Mock<() => Promise<void>>;
	enterDamaged: Mock<(check: () => Promise<unknown>) => void>;
	reloadOnUnlock: boolean;
};

const h = vi.hoisted(() => ({ app: {} as Record<string, unknown> }));
// The rest of the module stays real: app-init, imported below for the relock join, reads helpers from it.
vi.mock('$lib/profile/context', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/profile/context')>()),
	getProfileApp: () => h.app
}));

const HMAC = { name: 'HMAC', hash: 'SHA-256', length: 256 } as const;
const GOOD = '1234';
const WRONG = '9999';
const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};

const NOT_RIGHT = 'That PIN is not right.';
const WAIT_30 = 'That PIN is not right. You can try again in 30 seconds.';
const LOW_MEMORY =
	'This phone ran out of memory while checking your PIN. Your PIN may be right. Close other apps and tabs, then try again.';
const UNLOCK_FAILED = 'Could not unlock right now - please try again.';
const NO_TRIES: TriesState = { count: 0, waitMs: 0, pending: false };

// Captured before any test fakes the timers: the waits below must stay real.
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

/**
 * A PIN row built from test-made keys, as the PIN step makes them (non-extractable MAC and wrapping keys). The data key
 * and the HMAC key are extractable here only to be wrapped into the bag.
 */
async function pinFixture() {
	const macKey = await crypto.subtle.generateKey(HMAC, false, ['sign', 'verify']);
	const kek = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, [
		'wrapKey',
		'unwrapKey'
	]);
	const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
		'encrypt',
		'decrypt'
	]);
	const hmacKey = await crypto.subtle.generateKey(HMAC, true, ['sign', 'verify']);
	const bag = new Uint8Array(80);
	bag.set(new Uint8Array(await crypto.subtle.wrapKey('raw', dataKey, kek, 'AES-KW')), 0);
	bag.set(new Uint8Array(await crypto.subtle.wrapKey('raw', hmacKey, kek, 'AES-KW')), 40);
	const row: KeystoreRecordPin & { id: number } = {
		id: 0,
		v: 1,
		mode: 'pin',
		keystoreGeneration: 0,
		epoch: 0,
		ivCounter: 0,
		installUuid: crypto.getRandomValues(new Uint8Array(16)),
		kdf: { ...KDF_V1 },
		salt: crypto.getRandomValues(new Uint8Array(16)),
		bag
	};
	row.recordHmac = await signKeystore(row, { bootstrapMacKey: macKey });
	return { row, macKey, kek };
}

let db: IDBDatabase;
let fx: Awaited<ReturnType<typeof pinFixture>>;
let wrongMac: CryptoKey;
let relockables: Relockable[];
let app: TestApp;
let derive: Mock<(pin: string) => Promise<{ macKey: CryptoKey; kek: CryptoKey }>>;
let reload: Mock<() => void>;
let onunlocked: Mock<() => void>;

const putRow = (row: object) =>
	withStores(db, 'keystore', 'readwrite', (tx) => {
		tx.objectStore('keystore').put(row);
	});
const putTries = (tries: TriesState) =>
	withStores(db, 'app-lock', 'readwrite', (tx) => {
		tx.objectStore('app-lock').put({ id: 'tries', ...tries });
	});

beforeEach(async () => {
	db = await openTestDb();
	fx = await pinFixture();
	wrongMac = await crypto.subtle.generateKey(HMAC, false, ['sign', 'verify']);
	await putRow(fx.row);
	relockables = [];
	app = {
		status: 'ready',
		keyMode: 'pin',
		pinLocked: true,
		db,
		joinRelock: createJoinRelock(relockables),
		unlockStores: vi.fn(async () => {}),
		enterDamaged: vi.fn(),
		reloadOnUnlock: false
	};
	h.app = app;
	// The real Argon2id is the worker's; here the PIN decides which MAC key comes back, so only the right one opens the row.
	derive = vi.fn(async (pin: string) => ({
		macKey: pin === GOOD ? fx.macKey : wrongMac,
		kek: fx.kek
	}));
	reload = vi.fn();
	onunlocked = vi.fn();
});

afterEach(async () => {
	vi.useRealTimers();
	dropSession();
	await deleteTestDb(db);
});

async function mount(over: PinUnlockDeps = {}, props: { takeFocus?: boolean } = {}) {
	const rendered = await render(PinUnlock, {
		props: { onunlocked, ...props, deps: { derive, reload, ...over } }
	});
	return rendered;
}

const field = () => page.getByLabelText('PIN', { exact: true });
const fieldEl = () => field().element() as HTMLInputElement;
const unlockEl = () => page.getByRole('button', { name: /^Unlock/ }).element() as HTMLButtonElement;
const showEl = () => page.getByRole('button', { name: 'Show PIN' }).element() as HTMLButtonElement;
const alertText = () => document.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
const digits = () => Array.from(document.querySelectorAll('ul li'), (li) => li.textContent);
const settled = () => unlockEl().textContent?.trim() === 'Unlock';

async function press(pin: string): Promise<void> {
	await field().fill(pin);
	unlockEl().click();
	await until(() => fieldEl().value === '' && settled(), 'the press ended and emptied the field');
}

describe('a good PIN', () => {
	it('sets the session, then loads the stores once, and tells the page', async () => {
		let sessionWhenLoading: ReturnType<typeof getSession> = null;
		app.unlockStores.mockImplementation(async () => {
			sessionWhenLoading = getSession();
		});
		await mount();
		await press(GOOD);
		await until(() => onunlocked.mock.calls.length > 0, 'the page was told it unlocked');

		expect(app.unlockStores).toHaveBeenCalledTimes(1);
		expect(sessionWhenLoading).not.toBeNull();
		expect(onunlocked).toHaveBeenCalledTimes(1);
		expect(fieldEl().value).toBe('');
		expect(await readTries(db)).toEqual(NO_TRIES);
	});

	// unlockStores drops the session itself when the profile will not open, so a retry is a fresh unlock.
	it('says it could not unlock when the stores will not load, and stays', async () => {
		app.unlockStores.mockRejectedValue(new Error('E_TEST'));
		await mount();
		await press(GOOD);

		expect(alertText()).toBe(UNLOCK_FAILED);
		expect(onunlocked).not.toHaveBeenCalled();
		expect(fieldEl().value).toBe('');
		expect(getSession()).toBeNull();
	});

	// The keys are set inside the check; any failure after that leaves the card up, and the keys must not stay behind it.
	it('holds no session when the tries reset fails after the keys were opened', async () => {
		let armed = false;
		derive.mockImplementation(async () => {
			armed = true;
			return { macKey: fx.macKey, kek: fx.kek };
		});
		const open = db.transaction.bind(db);
		vi.spyOn(db, 'transaction').mockImplementation(((
			stores: string | string[],
			mode?: IDBTransactionMode,
			options?: IDBTransactionOptions
		) => {
			if (armed && mode === 'readwrite') throw new Error('E_TEST_TX');
			return open(stores, mode, options);
		}) as typeof db.transaction);
		await mount();
		await press(GOOD);

		expect(alertText()).toBe(UNLOCK_FAILED);
		expect(getSession()).toBeNull();
		expect(app.unlockStores).not.toHaveBeenCalled();
		expect(onunlocked).not.toHaveBeenCalled();
	});

	it('holds no session when the app cannot load the stores', async () => {
		Reflect.deleteProperty(app, 'unlockStores');
		await mount();
		await press(GOOD);

		expect(alertText()).toBe(UNLOCK_FAILED);
		expect(getSession()).toBeNull();
	});
});

describe('a wrong PIN', () => {
	it('counts each try before the derive starts, and is a wrong PIN, never damage', async () => {
		const seen: TriesState[] = [];
		derive.mockImplementation(async (pin) => {
			seen.push(await readTries(db));
			return { macKey: pin === GOOD ? fx.macKey : wrongMac, kek: fx.kek };
		});
		await mount();
		await press(WRONG);

		expect(seen).toEqual([{ count: 1, waitMs: 0, pending: true }]);
		expect(await readTries(db)).toEqual({ count: 1, waitMs: 0, pending: false });
		expect(app.enterDamaged).not.toHaveBeenCalled();
		expect(app.unlockStores).not.toHaveBeenCalled();
	});

	it('says only that it is not right for tries 1 to 3, then how long to wait from the 4th', async () => {
		await mount();
		const lines: (string | null)[] = [];
		for (let i = 0; i < 4; i += 1) {
			await press(WRONG);
			lines.push(alertText());
			expect(fieldEl().value).toBe('');
		}
		expect(lines).toEqual([NOT_RIGHT, NOT_RIGHT, NOT_RIGHT, WAIT_30]);

		// A fifth press is only told to wait: no derive, no new try.
		await press(GOOD);
		expect(alertText()).toBe(WAIT_30);
		expect(derive).toHaveBeenCalledTimes(4);
		expect(await readTries(db)).toMatchObject({ count: 4, waitMs: 30_000 });
	});

	// Four digits are the least a PIN has: anything else could not be right, so it is neither derived nor counted.
	it('says it is not right for an entry that is not 4 to 6 digits, with no derive and no try counted', async () => {
		await mount();
		await press('123');

		expect(alertText()).toBe(NOT_RIGHT);
		expect(derive).not.toHaveBeenCalled();
		expect(await readTries(db)).toEqual(NO_TRIES);
	});
});

describe('a wait owed', () => {
	it('shows the wait when the card opens, and a press runs no derive', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		await mount();
		await until(() => alertText() !== null, 'the wait line at mount');
		expect(alertText()).toBe(WAIT_30);

		await press(GOOD);
		expect(derive).not.toHaveBeenCalled();
		expect(app.unlockStores).not.toHaveBeenCalled();
		expect(alertText()).toBe(WAIT_30);
	});

	// The owed wait only ever shortens if something counts it down and writes the rest.
	it('counts the wait down: after 5 seconds the stored remainder is lower', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
		let now = 0;
		await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() !== null, 'the wait line at mount');

		now = 5_000;
		vi.advanceTimersByTime(5_000);
		await until(async () => (await readTries(db)).waitMs < 30_000, 'a lower stored remainder');
		expect((await readTries(db)).waitMs).toBe(25_000);
	});

	it('takes the line away when the wait reaches zero', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
		let now = 0;
		await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() !== null, 'the wait line at mount');

		now = 30_000;
		vi.advanceTimersByTime(30_000);
		await until(() => alertText() === null, 'the wait line gone');
		expect(alertText()).toBeNull();
	});

	it.each([
		['the app relocks', () => relockEachSync(relockables, 'user')],
		['the card is taken out', null]
	])('stops counting down when %s', async (_name, stop) => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
		let now = 0;
		const rendered = await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() !== null, 'the wait line at mount');

		if (stop) stop();
		else await rendered.unmount();
		now = 5_000;
		vi.advanceTimersByTime(5_000);
		await real(100);
		expect((await readTries(db)).waitMs).toBe(30_000);
	});

	// A person who keeps pressing Unlock while they wait must not push the end of the wait away: the count runs on, and
	// the right PIN opens once it is over.
	it('keeps counting through presses made every 3 seconds, and opens once the wait is over', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
		let now = 0;
		await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() !== null, 'the wait line at mount');

		// Typed straight into the field and pressed in the page: the fake timers are the page's own.
		const pressOnce = async () => {
			fieldEl().value = GOOD;
			fieldEl().dispatchEvent(new Event('input', { bubbles: true }));
			unlockEl().click();
			await until(
				() => fieldEl().value === '' && settled(),
				'the press ended and emptied the field'
			);
		};
		const lines: (string | null)[] = [];
		for (let i = 0; i < 9; i += 1) {
			now += 3_000;
			vi.advanceTimersByTime(3_000);
			await pressOnce();
			lines.push(alertText());
		}
		expect(lines.at(2)).toBe('That PIN is not right. You can try again in 21 seconds.');
		expect(lines.at(-1)).toBe('That PIN is not right. You can try again in 3 seconds.');
		expect(derive).not.toHaveBeenCalled();

		now += 3_000;
		vi.advanceTimersByTime(3_000);
		await until(async () => (await readTries(db)).waitMs === 0, 'the stored wait at zero');
		await pressOnce();
		await until(() => onunlocked.mock.calls.length > 0, 'the page was told it unlocked');
		expect(derive).toHaveBeenCalledTimes(1);
	});
});

describe('a phone that ran out of memory', () => {
	it('says so, and the try is not counted', async () => {
		derive.mockRejectedValue(new PinNoMemoryError());
		await mount();
		await press(GOOD);

		expect(alertText()).toBe(LOW_MEMORY);
		expect(await readTries(db)).toEqual(NO_TRIES);
		expect(app.unlockStores).not.toHaveBeenCalled();
	});
});

describe('a damaged row', () => {
	// No PIN could open a row whose salt is the wrong size, so it is never a wrong try; the erase has to be offered.
	it('opens the damaged screen with a check by the stored bytes, and counts nothing', async () => {
		const damaged = { ...fx.row, salt: new Uint8Array(8) };
		await putRow(damaged);
		await mount();
		await press(GOOD);

		expect(await readTries(db)).toEqual(NO_TRIES);
		expect(alertText()).toBeNull();
		expect(app.enterDamaged).toHaveBeenCalledTimes(1);
		const check = need(app.enterDamaged.mock.calls[0])[0];
		await expect(check()).rejects.toThrow(KeystoreHmacMismatchError);

		// Another tab replaced the row: the same check now resolves, so the erase reloads instead of wiping.
		await putRow((await pinFixture()).row);
		await expect(check()).resolves.toBeUndefined();
		expect(reload).not.toHaveBeenCalled();
	});

	it('reloads, and does not open the damaged screen, when another tab changed the row meanwhile', async () => {
		await putRow({ ...fx.row, salt: new Uint8Array(8) });
		const other = (await pinFixture()).row;
		derive.mockImplementation(async () => {
			await putRow(other);
			return { macKey: fx.macKey, kek: fx.kek };
		});
		await mount();
		await press(GOOD);

		expect(app.enterDamaged).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalledTimes(1);
	});
});

describe('the row is read inside the check', () => {
	it('writes the try, then reads the row, then derives', async () => {
		const order: string[] = [];
		const readRow: PinUnlockDeps['readRow'] = async (database) => {
			const tries = await readTries(database);
			order.push(tries.count === 1 && tries.pending ? 'row (try already written)' : 'row');
			return readPinRowAndCounter(database);
		};
		derive.mockImplementation(async (pin) => {
			order.push('derive');
			return { macKey: pin === GOOD ? fx.macKey : wrongMac, kek: fx.kek };
		});
		await mount({ readRow });
		await press(GOOD);

		expect(order).toEqual(['row (try already written)', 'derive']);
	});

	it.each([
		['turned local between presses', async () => putRow(await localRow())],
		[
			'is gone',
			async () => {
				await withStores(db, 'keystore', 'readwrite', (tx) => {
					tx.objectStore('keystore').delete(0);
				});
			}
		]
	])('reloads, and counts nothing, when the lock %s', async (_name, change) => {
		await mount();
		await change();
		await press(GOOD);

		expect(reload).toHaveBeenCalledTimes(1);
		expect(derive).not.toHaveBeenCalled();
		expect(app.unlockStores).not.toHaveBeenCalled();
		expect(await readTries(db)).toEqual(NO_TRIES);
	});

	// A restore replaced the data while this tab was locked: reading it again would open stale data.
	it('reloads on the next press when the data was replaced meanwhile, before anything is derived', async () => {
		app.reloadOnUnlock = true;
		await mount();
		await field().fill(GOOD);
		unlockEl().click();
		await until(() => reload.mock.calls.length > 0, 'a reload');

		expect(derive).not.toHaveBeenCalled();
		expect(await readTries(db)).toEqual(NO_TRIES);
	});
});

async function localRow() {
	const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
		'encrypt',
		'decrypt'
	]);
	const hmacKey = await crypto.subtle.generateKey(HMAC, false, ['sign', 'verify']);
	return {
		id: 0,
		v: 1,
		mode: 'local',
		keystoreGeneration: 0,
		epoch: 0,
		ivCounter: 0,
		installUuid: new Uint8Array(16).fill(9),
		dataKeyRef: dataKey,
		hmacKeyRef: hmacKey
	};
}

function need<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('test setup: value missing');
	return value;
}

describe('what stays in the page', () => {
	it('empties the field and hides the shown digits after a result', async () => {
		await mount();
		await field().fill(WRONG);
		showEl().click();
		await until(() => digits().length === 4, 'the shown digits');
		unlockEl().click();
		await until(() => alertText() !== null && settled(), 'the result');

		expect(fieldEl().value).toBe('');
		expect(digits()).toEqual([]);
	});

	// Without the app's relock join a scrub empties the DOM but not the value the page reads on its next press.
	it('empties the field and hides the digits when the app relocks', async () => {
		await mount();
		await field().fill(GOOD);
		showEl().click();
		await until(() => digits().length === 4, 'the shown digits');

		relockEachSync(relockables, 'user');
		await until(() => digits().length === 0, 'the digits hidden by the relock');
		expect(fieldEl().value).toBe('');
		unlockEl().click();
		await until(() => alertText() !== null, 'the line for an empty entry');
		expect(derive).not.toHaveBeenCalled();
	});
});

describe('a second press while a check runs', () => {
	// A double tap on a slow phone: the first check has not ended, so the field still holds the PIN, and a second check
	// would count a second wrong try for one typing.
	it('is ignored, and the button says it is working', async () => {
		derive.mockImplementation(async () => {
			await real(150);
			return { macKey: wrongMac, kek: fx.kek };
		});
		await mount();
		await field().fill(WRONG);
		unlockEl().click();
		await until(() => unlockEl().getAttribute('aria-busy') === 'true', 'the button busy');
		expect(unlockEl().textContent?.trim()).toBe('Unlocking...');
		unlockEl().click();
		await until(() => fieldEl().value === '' && settled(), 'the check ended');

		expect(derive).toHaveBeenCalledTimes(1);
		expect((await readTries(db)).count).toBe(1);
	});
});

describe('held keys', () => {
	// The check is slow enough that the held key's repeats run on past it: they must neither start another nor put a
	// "not right" line over the wait the check ended with.
	async function slowDerive(): Promise<void> {
		await putTries({ count: 3, waitMs: 0, pending: false });
		derive.mockImplementation(async () => {
			await real(100);
			return { macKey: wrongMac, kek: fx.kek };
		});
	}

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

	async function ranOnce(): Promise<void> {
		expect(derive).toHaveBeenCalledTimes(1);
		expect(alertText()).toBe(WAIT_30);
		expect((await readTries(db)).count).toBe(4);
	}

	it('runs one check for an Enter held in the field', async () => {
		await slowDerive();
		await mount();
		await field().fill(WRONG);
		fieldEl().focus();
		await hold();
		await ranOnce();
	});

	it('runs one check for an Enter held on Unlock', async () => {
		await slowDerive();
		await mount();
		await field().fill(WRONG);
		unlockEl().focus();
		await hold();
		await ranOnce();
	});

	// The Lock button in Settings hands focus to the card during the press, so the same held key's repeats land on it.
	it.each([
		['the field', () => fieldEl()],
		['Unlock', () => unlockEl()]
	])('does not let an Enter held from another button press %s', async (_name, target) => {
		await mount();
		const lock = document.body.appendChild(document.createElement('button'));
		try {
			lock.focus();
			const session = cdp();
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
			target().focus();
			for (let i = 0; i < 5; i += 1) {
				await real(40);
				await session.send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					autoRepeat: true,
					...ENTER
				});
			}
			await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
			await real(50);

			expect(alertText()).toBeNull();
			expect(derive).not.toHaveBeenCalled();
		} finally {
			lock.remove();
		}
	});

	it('runs a check on a new Enter in the field', async () => {
		await mount();
		await field().fill(GOOD);
		fieldEl().focus();
		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await until(() => onunlocked.mock.calls.length > 0, 'the page was told it unlocked');
		expect(derive).toHaveBeenCalledTimes(1);
	});
});

describe('focus', () => {
	// Lock moves the person from a button that is about to go; the page asks the card to take focus then, and only then.
	it('puts the cursor in the field when asked to take focus, and leaves focus alone otherwise', async () => {
		const first = await mount({}, { takeFocus: true });
		await until(() => document.activeElement === fieldEl(), 'focus in the field');
		await first.unmount();

		await mount();
		await real(100);
		expect(document.activeElement).toBe(document.body);
	});
});

describe('formatWait', () => {
	it.each([
		[1, '1 second'],
		[1_001, '2 seconds'],
		[29_001, '30 seconds'],
		[30_000, '30 seconds'],
		[59_000, '59 seconds'],
		[59_001, '1 minute'],
		[60_000, '1 minute'],
		[60_001, '2 minutes'],
		[300_000, '5 minutes'],
		[900_000, '15 minutes']
	])('%i ms reads %s', (ms, line) => {
		expect(formatWait(ms)).toBe(line);
	});
});
