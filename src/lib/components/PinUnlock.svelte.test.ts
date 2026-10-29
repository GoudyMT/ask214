import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { cdp, page } from 'vitest/browser';
import PinUnlock, { type PinUnlockDeps } from './PinUnlock.svelte';
// The colour tokens the card's borders are drawn from.
import '../../app.css';
import { KDF_V1 } from '../backup/kdf-params';
import { backupSession } from '../backup/session.svelte';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { withStores } from '../db/schema';
import { readTries, type TriesState } from '../keystore/app-lock-store';
import { readLockedDevice, restoreLockedDevice } from '../keystore/forgot-restore';
import { PinNoMemoryError } from '../keystore/pin-derive';
import { signKeystore, type KeystoreRecordPin } from '../keystore/record';
import { KeystoreHmacMismatchError } from '../keystore/read';
import { dropSession, getSession, openPinSession, setSession } from '../keystore/session';
import { readPinRowAndCounter } from '../keystore/unlock-row';
import { createJoinRelock, relockEachSync, type Relockable } from '../profile/app-init';
import { waitLine } from './pin-lines';

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

const h = vi.hoisted(() => ({
	app: {} as Record<string, unknown>,
	// What the Forgot screen handed the backup card, kept as the card was mounted.
	card: null as Record<string, unknown> | null
}));
// The rest of the module stays real: app-init, imported below for the relock join, reads helpers from it.
vi.mock('#lib/profile/context.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/profile/context.js')>()),
	getProfileApp: () => h.app
}));
// The real card, drawn as it is; the wrapper only keeps the props it was mounted with.
vi.mock('#lib/backup/BackupCard.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/backup/BackupCard.svelte')>();
	const mount = real.default as unknown as (
		anchor: unknown,
		props: Record<string, unknown>
	) => unknown;
	return {
		...real,
		default: (anchor: unknown, props: Record<string, unknown>) => {
			h.card = props;
			return mount(anchor, props);
		}
	};
});

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
const SINCE = 'since your last unlock.';
const UNFINISHED = 'One PIN try did not finish.';

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
let onunlocked: Mock<(notice: string[]) => void>;
let onerase: Mock<() => void>;

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
	onerase = vi.fn();
	h.card = null;
});

afterEach(async () => {
	vi.useRealTimers();
	dropSession();
	// The Forgot screen's backup card starts the tab's one backup session; a test must not leave it running.
	backupSession.relockSync('user');
	backupSession.takeEraseRequest();
	await deleteTestDb(db);
});

async function mount(
	over: PinUnlockDeps = {},
	props: { takeFocus?: boolean; onforgot?: (open: boolean) => void } = {}
) {
	const rendered = await render(PinUnlock, {
		props: { onunlocked, onerase, ...props, deps: { derive, reload, ...over } }
	});
	return rendered;
}

const field = () => page.getByLabelText('PIN', { exact: true });
const fieldEl = () => field().element() as HTMLInputElement;
const unlockEl = () => page.getByRole('button', { name: /^Unlock/ }).element() as HTMLButtonElement;
const showEl = () => page.getByRole('button', { name: 'Show PIN' }).element() as HTMLButtonElement;
const alertText = () => document.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
/**
 * Counts the alerts put on the card from now on. A screen reader speaks an alert when its node is added, so a line that
 * stays in place is not spoken again.
 */
function watchAlerts(): () => Promise<number> {
	const card = document.querySelector('.pin-unlock');
	if (card === null) throw new Error('test setup: no card');
	let added = 0;
	const count = (records: MutationRecord[]) => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (
					node instanceof Element &&
					(node.matches('[role="alert"]') || node.querySelector('[role="alert"]'))
				) {
					added += 1;
				}
			}
		}
	};
	const observer = new MutationObserver(count);
	observer.observe(card, { childList: true, subtree: true });
	onTestFinished(() => observer.disconnect());
	return async () => {
		await tick();
		count(observer.takeRecords());
		return added;
	};
}
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

	// What the person is told about the tries before this good one, from the row the check really read.
	it.each<[string, TriesState, string[]]>([
		['no wrong tries', NO_TRIES, []],
		['three wrong tries', { count: 3, waitMs: 0, pending: false }, [`3 wrong PIN tries ${SINCE}`]],
		['one wrong try', { count: 1, waitMs: 0, pending: false }, [`1 wrong PIN try ${SINCE}`]],
		['a try that did not finish', { count: 1, waitMs: 0, pending: true }, [UNFINISHED]],
		[
			'three tries, the last of them cut off',
			{ count: 3, waitMs: 0, pending: true },
			[`2 wrong PIN tries ${SINCE}`, UNFINISHED]
		]
	])('tells the page about %s with the lines to show', async (_what, tries, lines) => {
		await putTries(tries);
		await mount();
		await press(GOOD);
		await until(() => onunlocked.mock.calls.length > 0, 'the page was told it unlocked');

		expect(onunlocked).toHaveBeenCalledTimes(1);
		expect(onunlocked).toHaveBeenCalledWith(lines);
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
});

describe('a lock that lands while the derive runs', () => {
	/** Starts a press with the right PIN and holds its derive until the test lets it go. */
	async function holdDerive(): Promise<() => void> {
		let letGo: () => void = () => {};
		derive.mockImplementation(
			() =>
				new Promise((resolve) => {
					letGo = () => resolve({ macKey: fx.macKey, kek: fx.kek });
				})
		);
		await mount();
		await field().fill(GOOD);
		unlockEl().click();
		await until(() => derive.mock.calls.length > 0, 'the derive started');
		return () => letGo();
	}

	// The phone sleeps mid-unlock and wakes past the idle limit: the relock comes before the derive ends, and the keys
	// that derive makes must not outlive it. Idle does not move the lock counter, so nothing else would catch it.
	it.each(['idle', 'user'] as const)(
		'holds no session and opens nothing when a %s lock lands during the derive',
		async (reason) => {
			const letGo = await holdDerive();
			relockEachSync(relockables, reason);
			letGo();
			await until(settled, 'the press ended');

			expect(app.unlockStores).not.toHaveBeenCalled();
			expect(getSession()).toBeNull();
			expect(onunlocked).not.toHaveBeenCalled();
			expect(alertText()).toBeNull();
		}
	);

	// A switch away locks nothing: the person is still unlocking.
	it('goes on when only a switch away (hygiene) lands during the derive', async () => {
		const letGo = await holdDerive();
		relockEachSync(relockables, 'hygiene');
		letGo();
		await until(() => onunlocked.mock.calls.length > 0, 'the page was told it unlocked');

		expect(app.unlockStores).toHaveBeenCalledTimes(1);
		expect(getSession()).not.toBeNull();
	});

	// A lock that lands after the keys were set but before the press ended (the tries reset is still being written)
	// is caught too; a session someone else set meanwhile is not the press's to drop.
	it('drops only its own session, when a lock lands after the keys were set', async () => {
		const { counter } = await readPinRowAndCounter(db);
		const other = await openPinSession(fx.row, { macKey: fx.macKey, kek: fx.kek }, counter);
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
			if (armed && mode === 'readwrite') {
				armed = false;
				relockEachSync(relockables, 'user');
				setSession(other);
			}
			return open(stores, mode, options);
		}) as typeof db.transaction);
		await mount();
		await press(GOOD);

		expect(app.unlockStores).not.toHaveBeenCalled();
		expect(onunlocked).not.toHaveBeenCalled();
		expect(getSession()).toBe(other);
	});

	// The dropped good PIN has already reset the tries row, so only this tab still knows about the tries before it.
	it('tells the tries before a good PIN the lock dropped at the next good unlock, with the tries since', async () => {
		await putTries({ count: 3, waitMs: 0, pending: false });
		let letGo: () => void = () => {};
		derive.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					letGo = () => resolve({ macKey: fx.macKey, kek: fx.kek });
				})
		);
		await mount();
		await field().fill(GOOD);
		unlockEl().click();
		await until(() => derive.mock.calls.length > 0, 'the derive started');
		relockEachSync(relockables, 'idle');
		letGo();
		await until(settled, 'the press ended');
		expect(onunlocked).not.toHaveBeenCalled();

		await press('9999');
		await press(GOOD);
		await until(() => onunlocked.mock.calls.length > 0, 'the page was told it unlocked');
		expect(onunlocked).toHaveBeenCalledOnce();
		expect(onunlocked).toHaveBeenCalledWith([`4 wrong PIN tries ${SINCE}`]);
	});
});

describe('a lock that lands while the stores load', () => {
	it('does not tell the page it unlocked, holds no session, and tells the tries at the next good unlock', async () => {
		await putTries({ count: 2, waitMs: 0, pending: false });
		app.unlockStores.mockImplementationOnce(async () => {
			relockEachSync(relockables, 'user');
		});
		await mount();
		await press(GOOD);

		expect(app.unlockStores).toHaveBeenCalledTimes(1);
		expect(onunlocked).not.toHaveBeenCalled();
		expect(getSession()).toBeNull();

		await press(GOOD);
		await until(() => onunlocked.mock.calls.length > 0, 'the page was told it unlocked');
		expect(onunlocked).toHaveBeenCalledOnce();
		expect(onunlocked).toHaveBeenCalledWith([`2 wrong PIN tries ${SINCE}`]);
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

	// A line that stays on the page is not spoken again: the second short entry must put a new alert there.
	it('puts the line on the page again for a second short entry in a row', async () => {
		await mount();
		const alerts = watchAlerts();
		await press('123');
		await press('123');

		expect(alertText()).toBe(NOT_RIGHT);
		expect(await alerts()).toBe(2);
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

	// The wait is the tab's, not the card's: reading Resources while locked is time waited.
	it('keeps counting down when the card is taken out', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
		let now = 0;
		const rendered = await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() !== null, 'the wait line at mount');

		await rendered.unmount();
		now = 5_000;
		vi.advanceTimersByTime(5_000);
		await until(async () => (await readTries(db)).waitMs === 25_000, 'the remainder written');
		expect((await readTries(db)).waitMs).toBe(25_000);
	});

	it('shows what is left when the card comes back after the wait went on without it', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
		let now = 0;
		const rendered = await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() !== null, 'the wait line at mount');
		await rendered.unmount();
		now = 10_000;
		vi.advanceTimersByTime(10_000);

		await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() === waitLine(20_000), 'the wait line with what is left');
		await until(async () => (await readTries(db)).waitMs <= 20_000, 'the stored wait lowered');
		expect(alertText()).toBe(waitLine(20_000));
	});

	// The stored remainder is written every 5 s, so between writes it is older than the running count. A card that started
	// again from it would push the end away on every move between locked pages.
	it('does not push the end away when the card comes back between two writes', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
		let now = 0;
		const rendered = await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() !== null, 'the wait line at mount');
		await rendered.unmount();
		now = 5_000;
		vi.advanceTimersByTime(5_000);
		await until(async () => (await readTries(db)).waitMs === 25_000, 'the write at 5 s');
		now = 7_000;
		vi.advanceTimersByTime(2_000);

		await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() === waitLine(23_000), 'the wait line with what is left');
		// The mount's own read of the stored row (25 s) lands after the line was handed over.
		await readTries(db);
		now = 10_000;
		vi.advanceTimersByTime(3_000);
		await until(() => alertText() === waitLine(20_000), 'the line three seconds later');
		expect(alertText()).toBe(waitLine(20_000));
	});

	// A good check reset the row. The card stays up here, so a count that went on would lower the next wait at that count.
	it('ends the count when a good PIN opens', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
		let now = 0;
		await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() !== null, 'the wait line at mount');
		// The wait ran out in another tab, so this press is checked.
		await putTries({ count: 4, waitMs: 0, pending: false });
		fieldEl().value = GOOD;
		fieldEl().dispatchEvent(new Event('input', { bubbles: true }));
		unlockEl().click();
		await until(() => onunlocked.mock.calls.length > 0, 'the page was told it unlocked');
		await putTries({ count: 4, waitMs: 30_000, pending: false });

		now = 5_000;
		vi.advanceTimersByTime(5_000);
		await real(100);
		expect((await readTries(db)).waitMs).toBe(30_000);
	});

	// A Lock hides nothing of the wait: the card is still up and the wait is still owed, so the count goes on.
	it('keeps counting down when the app relocks', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
		let now = 0;
		await mount({ clock: { perfNow: () => now } });
		await until(() => alertText() !== null, 'the wait line at mount');

		relockEachSync(relockables, 'user');
		now = 5_000;
		vi.advanceTimersByTime(5_000);
		await until(async () => (await readTries(db)).waitMs === 25_000, 'the remainder written');
		expect(alertText()).toBe(waitLine(25_000));
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

describe('the wait line, live', () => {
	const TIMERS = ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const;
	let now: number;
	let date: number;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A card with a wait owed, on a clock the test moves; the page is shown. */
	async function owed(waitMs: number): Promise<void> {
		await putTries({ count: 4, waitMs, pending: false });
		vi.useFakeTimers({ toFake: [...TIMERS] });
		now = 0;
		date = 1_700_000_000_000;
		await mount({ clock: { perfNow: () => now }, dateNow: () => date });
		await until(() => alertText() !== null, 'the wait line at mount');
	}

	/** Time passing in a shown page: both clocks and the page's timers move together. */
	async function pass(ms: number): Promise<void> {
		now += ms;
		date += ms;
		vi.advanceTimersByTime(ms);
		await tick();
	}

	async function pageIs(state: 'hidden' | 'visible'): Promise<void> {
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
		document.dispatchEvent(new Event('visibilitychange'));
		await tick();
	}

	it('shows each second of the wait, in minutes above a minute, and takes the line away at zero', async () => {
		await owed(90_000);
		expect(alertText()).toBe(waitLine(90_000));
		expect(alertText()).toContain('2 minutes');

		await pass(30_000);
		expect(alertText()).toContain('1 minute.');
		await pass(30_000);
		expect(alertText()).toBe(waitLine(30_000));
		await pass(1_000);
		expect(alertText()).toBe(waitLine(29_000));
		await pass(29_000);
		expect(alertText()).toBeNull();
		await until(async () => (await readTries(db)).waitMs === 0, 'the stored wait at zero');
	});

	// A screen reader speaks the alert when it appears, not again on each tick: the part that changes sits in a child that
	// is not live, and it changes in place.
	it('changes the seconds inside the same alert, under a child that is not live', async () => {
		await owed(30_000);
		const alert = document.querySelector('[role="alert"]');
		const changing = alert?.querySelector('[aria-live="off"]');
		expect(changing?.textContent).toBe(waitLine(30_000));

		await pass(1_000);

		expect(document.querySelector('[role="alert"]')).toBe(alert);
		expect(alert?.querySelector('[aria-live="off"]')).toBe(changing);
		expect(changing?.textContent).toBe(waitLine(29_000));
	});

	it('does not write the wait down while the page is hidden, and counts the time away when both clocks agree', async () => {
		await owed(30_000);
		await pageIs('hidden');
		now += 10_000;
		date += 10_000;
		vi.advanceTimersByTime(10_000);
		await real(100);
		expect((await readTries(db)).waitMs).toBe(30_000);

		await pageIs('visible');
		expect(alertText()).toBe(waitLine(20_000));
		await pass(5_000);
		await until(async () => (await readTries(db)).waitMs === 15_000, 'the remainder written');
	});

	// A wait that begins in a hidden page is held to the same rule as one that was running when the page was hidden.
	it('writes nothing for a wait found by a card opened in a hidden page, and counts the time away when both clocks agree', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		vi.useFakeTimers({ toFake: [...TIMERS] });
		now = 0;
		date = 1_700_000_000_000;
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		await mount({ clock: { perfNow: () => now }, dateNow: () => date });
		await until(() => alertText() !== null, 'the wait line at mount');

		now += 10_000;
		date += 10_000;
		vi.advanceTimersByTime(10_000);
		await real(100);
		expect((await readTries(db)).waitMs).toBe(30_000);
		expect(alertText()).toBe(waitLine(30_000));

		await pageIs('visible');
		expect(alertText()).toBe(waitLine(20_000));
	});

	it('writes nothing for a wait a wrong try earned while the page was hidden, and does not count a time away the Date clock disagrees with', async () => {
		await putTries({ count: 3, waitMs: 0, pending: false });
		vi.useFakeTimers({ toFake: [...TIMERS] });
		now = 0;
		date = 1_700_000_000_000;
		await mount({ clock: { perfNow: () => now }, dateNow: () => date });
		await pageIs('hidden');
		fieldEl().value = WRONG;
		fieldEl().dispatchEvent(new Event('input', { bubbles: true }));
		unlockEl().click();
		await until(() => alertText() === waitLine(30_000), 'the wait the wrong try earned');

		now += 10_000;
		date += 100_000;
		vi.advanceTimersByTime(10_000);
		await real(100);
		expect((await readTries(db)).waitMs).toBe(30_000);

		await pageIs('visible');
		expect(alertText()).toBe(waitLine(30_000));
	});

	it.each([
		['the Date clock moved far more than the performance clock', 10_000, 100_000],
		['the Date clock went back', 10_000, -50_000]
	])('does not count the time away when %s', async (_name, byPerf, byDate) => {
		await owed(30_000);
		await pageIs('hidden');
		now += byPerf;
		date += byDate;
		await pageIs('visible');

		expect(alertText()).toBe(waitLine(30_000));
		await pass(5_000);
		await until(async () => (await readTries(db)).waitMs === 25_000, 'the remainder written');
	});

	// By design, a press during a wait is refused whatever was typed, so a PIN that could not be right is answered with
	// the wait, which is what stops the press, not with a line about the PIN. Nothing is checked or counted, and the wait
	// runs on to its end.
	it('keeps the wait line, counting on, for a press with a PIN that could not be right', async () => {
		await owed(30_000);
		await pass(5_000);
		fieldEl().value = '12';
		fieldEl().dispatchEvent(new Event('input', { bubbles: true }));
		unlockEl().click();
		await until(() => fieldEl().value === '', 'the press ended and emptied the field');
		await real(100);

		expect(alertText()).toBe(waitLine(25_000));
		expect(derive).not.toHaveBeenCalled();
		expect((await readTries(db)).count).toBe(4);
		await pass(5_000);
		expect(alertText()).toBe(waitLine(20_000));
		await pass(20_000);
		await until(() => alertText() === null, 'the line gone at the end of the wait');
	});

	// A key held on Unlock repeats while the wait is owed: only the first press counts, so no repeat checks anything or puts
	// a "not right" line over the wait.
	it('runs no check, and keeps the wait line, for an Enter held on Unlock while a wait is owed', async () => {
		await owed(30_000);
		fieldEl().value = GOOD;
		fieldEl().dispatchEvent(new Event('input', { bubbles: true }));
		unlockEl().focus();
		await keyEnter('keyDown');
		await repeatEnter(4);
		await keyEnter('keyUp');
		await real(100);

		expect(alertText()).toBe(waitLine(30_000));
		expect(derive).not.toHaveBeenCalled();
		expect((await readTries(db)).count).toBe(4);
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

// ---- Forgot PIN ----------------------------------------------------------------------------------------------------------

const FORGOT_LINES = [
	'Forgot your PIN?',
	'Your PIN is not saved anywhere, so no one can reset it. You have two ways back.',
	'Restore from a backup',
	'Uses a backup file you saved and its six words.',
	'Erase and start over',
	'Removes everything saved on this device, so the app can start again.',
	'Back to Unlock'
];

const forgotEl = () =>
	page.getByRole('button', { name: 'Forgot PIN?', exact: true }).element() as HTMLButtonElement;
const restoreEl = () =>
	page.getByRole('button', { name: 'Restore from a backup', exact: true }).element() as HTMLElement;
const eraseEl = () =>
	page.getByRole('button', { name: 'Erase and start over', exact: true }).element() as HTMLElement;
const backEl = () =>
	page.getByRole('button', { name: 'Back to Unlock', exact: true }).element() as HTMLElement;
const forgotHeading = () => page.getByRole('heading', { name: 'Forgot your PIN?', exact: true });
const unlockHeading = () => page.getByRole('heading', { name: 'Your data is locked', exact: true });
const cardLines = () =>
	Array.from(document.querySelectorAll('.pin-unlock h2, .pin-unlock p, .pin-unlock button'), (el) =>
		el.textContent?.trim()
	);
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
const restoreToggle = () => document.getElementById('backup-toggle-restore');

async function openForgot(): Promise<void> {
	forgotEl().click();
	await expect.element(forgotHeading()).toBeVisible();
}

/** An Enter pressed on the focused control and held: the first press, then the key's repeats, then the release. */
async function holdEnter(repeats = 5): Promise<void> {
	const session = cdp();
	await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
	for (let i = 0; i < repeats; i += 1) {
		await real(40);
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
	}
	await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
	await real(50);
	await frame();
}

/** The three parts of a held Enter, apart, so a test can look at what has happened between them. */
const keyEnter = (type: 'keyDown' | 'keyUp', autoRepeat = false) =>
	cdp().send('Input.dispatchKeyEvent', { type, ...(autoRepeat && { autoRepeat }), ...ENTER });
async function repeatEnter(repeats: number): Promise<void> {
	for (let i = 0; i < repeats; i += 1) {
		await real(40);
		await keyEnter('keyDown', true);
	}
}

describe('Forgot PIN', () => {
	it('opens the Forgot screen in the same card with its copy exactly, and the Unlock form is gone', async () => {
		await mount();
		expect(cardLines()).not.toContain('Forgot your PIN?');
		await openForgot();

		expect(cardLines()).toEqual(FORGOT_LINES);
		expect(unlockHeading().query()).toBeNull();
		expect(field().query()).toBeNull();
		expect(document.querySelectorAll('.pin-unlock')).toHaveLength(1);
	});

	it('clears what was typed on the way in, and Back to Unlock returns with an empty field that has the cursor', async () => {
		await mount();
		await field().fill('12');
		await openForgot();

		backEl().click();
		await expect.element(unlockHeading()).toBeVisible();

		expect(fieldEl().value).toBe('');
		await until(() => document.activeElement === fieldEl(), 'the cursor in the PIN field');
		expect(cardLines()).not.toContain('Forgot your PIN?');
	});

	// The page hides a line that would be false above the Forgot screen: it has to know when that screen is up and when not.
	it('tells the page when the Forgot screen opens, when Back to Unlock closes it, and when the card goes', async () => {
		const onforgot = vi.fn<(open: boolean) => void>();
		const rendered = await mount({}, { onforgot });
		expect(onforgot).not.toHaveBeenCalled();

		await openForgot();
		expect(onforgot.mock.calls).toEqual([[true]]);

		backEl().click();
		await expect.element(unlockHeading()).toBeVisible();
		expect(onforgot.mock.calls).toEqual([[true], [false]]);

		await openForgot();
		await rendered.unmount();
		expect(onforgot.mock.calls).toEqual([[true], [false], [true], [false]]);
	});

	it('a restore card that cannot be fetched says the restore did not open, and leaves the button to try again', async () => {
		await mount({ loadRestore: () => Promise.reject(new Error('E_TEST_OFFLINE')) });
		await openForgot();

		restoreEl().click();
		await until(() => alertText() !== null || restoreToggle() !== null, 'the load settled');

		expect(alertText()).toBe('Could not open the restore right now - please try again.');
		expect(restoreToggle()).toBeNull();
		expect(restoreEl()).toBeTruthy();
	});

	it('puts the restore did-not-open line on the page again when a second try fails the same way', async () => {
		await mount({ loadRestore: () => Promise.reject(new Error('E_TEST_OFFLINE')) });
		await openForgot();
		const alerts = watchAlerts();

		restoreEl().click();
		await until(() => alertText() !== null, 'the first failure line');
		restoreEl().click();
		await until(async () => (await alerts()) >= 2, 'the line put on the page a second time');

		expect(alertText()).toBe('Could not open the restore right now - please try again.');
		expect(await alerts()).toBe(2);
	});

	it('Restore from a backup shows the backup card with only its restore row open, in place of the button', async () => {
		await mount();
		await openForgot();

		restoreEl().click();
		await until(() => restoreToggle() !== null, 'the backup card');

		expect(restoreToggle()?.getAttribute('aria-expanded')).toBe('true');
		expect(restoreToggle()?.textContent?.trim()).toBe('Restore from a backup');
		expect(document.querySelectorAll('#backup-toggle-check, #backup-toggle-export')).toHaveLength(
			0
		);
		// The card's row stands where the button stood: there is no second "Restore from a backup" to press.
		expect(page.getByRole('button', { name: 'Restore from a backup' }).elements()).toHaveLength(1);
		expect(cardLines()).not.toContain('Uses a backup file you saved and its six words.');
		// Erase and Back to Unlock stay below it.
		expect(eraseEl()).toBeTruthy();
		expect(backEl()).toBeTruthy();
		await until(() => document.activeElement === restoreToggle(), 'focus on the card row');
	});

	// A restore on a locked device must use the writer made for it: the shipped one reads keys this tab does not have.
	it("hands the card this tab's database, the locked-device writer, and the same Erase", async () => {
		await mount();
		await openForgot();

		restoreEl().click();
		await until(() => h.card !== null, 'the backup card');

		const card = need(h.card) as {
			db: unknown;
			only: unknown;
			restoreDeps: { lockedDevice: { read: unknown; write: unknown } };
			onEraseRequest: () => void;
		};
		expect(card.db).toBe(db);
		expect(card.only).toEqual({ row: 'restore', label: 'Restore from a backup', open: true });
		expect(card.restoreDeps.lockedDevice.read).toBe(readLockedDevice);
		expect(card.restoreDeps.lockedDevice.write).toBe(restoreLockedDevice);
		card.onEraseRequest();
		expect(onerase).toHaveBeenCalledTimes(1);
	});

	it('Erase and start over asks the page to erase, once', async () => {
		await mount();
		await openForgot();

		eraseEl().click();

		expect(onerase).toHaveBeenCalledTimes(1);
	});

	// A key still held when focus moves must neither press the control focus lands on nor leave the screen it came to.
	describe('held keys, at both ends of each hand-off', () => {
		it('an Enter held on Forgot PIN? opens the screen once and presses nothing on it', async () => {
			await mount();
			forgotEl().focus();

			await holdEnter();

			await expect.element(forgotHeading()).toBeVisible();
			expect(onerase).not.toHaveBeenCalled();
			expect(restoreToggle()).toBeNull();
			expect(cardLines()).toEqual(FORGOT_LINES);
			// Focus is on the heading, which nothing presses, not on any of the screen's buttons.
			expect(document.activeElement).toBe(forgotHeading().element());
		});

		it('an Enter held on Back to Unlock returns once, with the cursor in the field and no check run', async () => {
			await mount();
			await openForgot();
			backEl().focus();

			await holdEnter();

			await expect.element(unlockHeading()).toBeVisible();
			expect(document.activeElement).toBe(fieldEl());
			expect(derive).not.toHaveBeenCalled();
			expect(alertText()).toBeNull();
			expect(await readTries(db)).toEqual(NO_TRIES);
		});

		it('an Enter held on Restore from a backup opens the card once and does not close its row', async () => {
			await mount();
			await openForgot();
			restoreEl().focus();

			await holdEnter();

			await until(() => restoreToggle() !== null, 'the backup card');
			expect(restoreToggle()?.getAttribute('aria-expanded')).toBe('true');
			expect(document.querySelectorAll('#backup-toggle-restore')).toHaveLength(1);
			expect(onerase).not.toHaveBeenCalled();
		});

		it('an Enter held on Erase and start over asks for the erase once', async () => {
			await mount();
			await openForgot();
			eraseEl().focus();

			await holdEnter();

			expect(onerase).toHaveBeenCalledTimes(1);
		});

		// The page's Erase opens with its focus on Cancel: a key still down when it opens would press Cancel on its repeats.
		it('an Enter held on Erase and start over hands the erase over only once the key is let go', async () => {
			await mount();
			await openForgot();
			eraseEl().focus();

			await keyEnter('keyDown');
			await repeatEnter(3);
			expect(onerase).not.toHaveBeenCalled();

			await keyEnter('keyUp');
			await until(() => onerase.mock.calls.length > 0, 'the erase handed over');
			await real(50);
			expect(onerase).toHaveBeenCalledTimes(1);
		});

		it("the backup card's own Erase request waits for a held Enter in the same way", async () => {
			await mount();
			await openForgot();
			restoreEl().click();
			await until(() => h.card !== null, 'the backup card');
			(document.activeElement as HTMLElement | null)?.blur();
			const card = need(h.card) as { onEraseRequest: () => void };

			await keyEnter('keyDown');
			card.onEraseRequest();
			expect(onerase).not.toHaveBeenCalled();
			await keyEnter('keyUp');

			await until(() => onerase.mock.calls.length > 0, 'the erase handed over');
			expect(onerase).toHaveBeenCalledTimes(1);
		});

		it('hands the erase over at once when no Enter is down', async () => {
			await mount();
			await openForgot();
			await keyEnter('keyDown');
			await keyEnter('keyUp');
			eraseEl().click();

			expect(onerase).toHaveBeenCalledTimes(1);
		});

		// An Enter held on a button that opens the OS file picker has its release taken by the picker: the page never sees
		// it. Without a way to forget the key, every later click on Erase would wait for a release that never comes.
		it.each([
			['the window loses focus', 'blur'],
			['the page is hidden', 'hidden']
		] as const)(
			'a click on Erase and start over works at once after an Enter lost its release when %s',
			async (_name, how) => {
				await mount();
				await openForgot();
				await keyEnter('keyDown');
				const state = vi.spyOn(document, 'visibilityState', 'get');
				try {
					if (how === 'blur') {
						window.dispatchEvent(new Event('blur'));
					} else {
						state.mockReturnValue('hidden');
						document.dispatchEvent(new Event('visibilitychange'));
					}
					eraseEl().click();

					expect(onerase).toHaveBeenCalledTimes(1);
				} finally {
					state.mockRestore();
					await keyEnter('keyUp');
				}
			}
		);

		it('keeps waiting for an Enter release when the page is only shown again', async () => {
			await mount();
			await openForgot();
			await keyEnter('keyDown');
			const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
			try {
				document.dispatchEvent(new Event('visibilitychange'));
				eraseEl().click();

				expect(onerase).not.toHaveBeenCalled();
			} finally {
				state.mockRestore();
				await keyEnter('keyUp');
			}
			await until(() => onerase.mock.calls.length > 0, 'the erase handed over');
		});

		// A press that waits when focus leaves would answer the next Enter release of any control: it is let go with the key.
		it('drops a waiting erase when focus leaves the window, so a later Enter release hands nothing over', async () => {
			await mount();
			await openForgot();
			await keyEnter('keyDown');
			try {
				eraseEl().click();
				window.dispatchEvent(new Event('blur'));
			} finally {
				await keyEnter('keyUp');
			}
			await real(80);

			expect(onerase).not.toHaveBeenCalled();
		});

		it('two presses on Erase while an Enter is held hand the erase over once, on the release', async () => {
			await mount();
			await openForgot();
			await keyEnter('keyDown');
			try {
				eraseEl().click();
				eraseEl().click();
				expect(onerase).not.toHaveBeenCalled();
			} finally {
				await keyEnter('keyUp');
			}
			await until(() => onerase.mock.calls.length > 0, 'the erase handed over');
			// A second press must not have left a listener of its own behind for the next Enter.
			await keyEnter('keyDown');
			await keyEnter('keyUp');
			await real(50);

			expect(onerase).toHaveBeenCalledTimes(1);
		});

		it('Back to Unlock drops a waiting erase, so the next Enter release in the PIN field hands nothing over', async () => {
			await mount();
			await openForgot();
			await keyEnter('keyDown');
			try {
				eraseEl().click();
				backEl().click();
				await expect.element(unlockHeading()).toBeVisible();
				fieldEl().focus();
			} finally {
				await keyEnter('keyUp');
			}
			await real(80);

			expect(onerase).not.toHaveBeenCalled();
		});

		// The page's Erase must not open for a card that is no longer there: the person has moved on from the lock.
		it('hands nothing over when the card goes before a held Enter is let go', async () => {
			const rendered = await mount();
			await openForgot();
			eraseEl().focus();
			await keyEnter('keyDown');
			try {
				eraseEl().click();
				await rendered.unmount();
			} finally {
				await keyEnter('keyUp');
			}
			await real(80);

			expect(onerase).not.toHaveBeenCalled();
		});
	});

	describe('under forced colors', () => {
		it('the Restore button keeps an outline and the Erase button has a border of its own', async () => {
			await mount();
			await openForgot();
			const media = cdp();
			await media.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'active' }]
			});
			try {
				await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(true);
				for (const el of [restoreEl(), eraseEl()]) {
					const style = getComputedStyle(el);
					expect(style.borderTopWidth).toBe('1px');
					expect(style.borderTopStyle).toBe('solid');
				}
			} finally {
				await media.send('Emulation.setEmulatedMedia', {
					features: [{ name: 'forced-colors', value: 'none' }]
				});
			}
		});
	});
});

// Forced colors (Windows high contrast) repaint every colour from a small system palette and keep only borders and
// text: a filled button with no border becomes unmarked text.
describe('under forced colors', () => {
	it('the Unlock button keeps an outline', async () => {
		await mount();
		const media = cdp();
		await media.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'forced-colors', value: 'active' }]
		});
		try {
			await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(true);
			const outline = getComputedStyle(unlockEl());
			expect(outline.borderTopWidth).toBe('1px');
			expect(outline.borderTopStyle).toBe('solid');
		} finally {
			await media.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'none' }]
			});
		}
	});
});
