import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileApp } from '$lib/profile/context';
import type { IdleTimerOptions } from '$lib/profile/idle-timer';
import { createProfileStore } from '$lib/profile/store.svelte';
import { signSidecar } from '$lib/profile/sidecars';
import { createProfileBus, type BusSignal } from '$lib/broadcast/bus';
import { KDF_V1 } from '$lib/backup/kdf-params';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { bumpCounter, readCounter } from '$lib/keystore/app-lock-store';
import { signKeystore, type KeystoreRecordPin } from '$lib/keystore/record';
import {
	dropSession,
	getSession,
	KeystoreLockedError,
	openPinSession,
	setOnSessionMismatch,
	setSession
} from '$lib/keystore/session';
import { takeSnapshot } from '$lib/backup/snapshot';
import { eraseEverything } from '$lib/profile/erase';
import { KeystoreHmacMismatchError } from '$lib/keystore/read';
import { readDeviceState } from '$lib/profile/device-state';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { reqToPromise, withStores, type StoreName } from '$lib/db/schema';
import Layout from './+layout.svelte';

// The layout runs the real start-up on a test database with a PIN row, and a real BroadcastChannel carries the peer's
// signals; only the database it opens and the three seams a test must read (the app container, the idle timer's
// options, the profile store it creates) are intercepted. A reload cannot run in the test page, so every navigation is
// held at the browser's own navigate event and recorded.
const harness = vi.hoisted(() => ({
	db: null as Promise<IDBDatabase> | null,
	app: null as ProfileApp | null,
	idle: [] as IdleTimerOptions[],
	load: null as {
		mock: { calls: unknown[]; results: { value: unknown }[] };
		mockRejectedValueOnce: (e: unknown) => unknown;
	} | null,
	calendar: null as { load: () => Promise<void> } | null,
	timeline: null as { load: () => Promise<void> } | null
}));

vi.mock('$lib/db/schema', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/db/schema')>();
	return {
		...real,
		openMtcDb: (...args: Parameters<typeof real.openMtcDb>) =>
			args[0] === undefined ? harness.db : real.openMtcDb(...args)
	};
});
vi.mock('$lib/profile/context', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/profile/context')>();
	return {
		...real,
		setProfileApp: (app: ProfileApp) => {
			harness.app = app;
			real.setProfileApp(app);
		}
	};
});
vi.mock('$lib/profile/idle-timer', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/profile/idle-timer')>();
	return {
		...real,
		createIdleTimer: (opts: IdleTimerOptions) => {
			harness.idle.push(opts);
			return real.createIdleTimer(opts);
		}
	};
});
// The app container wraps each store in a reactive proxy, which a spy put on it would not reach: the raw store is kept.
vi.mock('$lib/calendar/store.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/calendar/store.svelte')>();
	return {
		...real,
		createCalendarSyncStore: (...args: Parameters<typeof real.createCalendarSyncStore>) => {
			const store = real.createCalendarSyncStore(...args);
			harness.calendar = store;
			return store;
		}
	};
});
vi.mock('$lib/timeline/state.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/timeline/state.svelte')>();
	return {
		...real,
		createTimelineStateStore: (...args: Parameters<typeof real.createTimelineStateStore>) => {
			const store = real.createTimelineStateStore(...args);
			harness.timeline = store;
			return store;
		}
	};
});
// The layout is the only caller that passes options, so its store is the one a spy is put on.
vi.mock('$lib/profile/store.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/profile/store.svelte')>();
	return {
		...real,
		createProfileStore: (...args: Parameters<typeof real.createProfileStore>) => {
			const store = real.createProfileStore(...args);
			if (args[1]) harness.load = vi.spyOn(store, 'load');
			return store;
		}
	};
});

const children = createRawSnippet(() => ({ render: () => '<p>page</p>' }));
const START_URL = location.href;
const EAOS = '2027-04-15';
let db: IDBDatabase | null = null;
let peer: ReturnType<typeof createProfileBus> | null = null;
let release: (() => void) | null = null;
let keys: { macKey: CryptoKey; kek: CryptoKey } | null = null;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const need = <T>(v: T | null | undefined): T => {
	if (v === null || v === undefined) throw new Error('test setup: missing');
	return v;
};

const putRaw = (store: StoreName, value: Record<string, unknown>) =>
	withStores(need(db), store, 'readwrite', (tx) => {
		tx.objectStore(store).put(value);
	});
const readRaw = (store: StoreName) =>
	withStores(need(db), store, 'readonly', (tx) =>
		reqToPromise<Record<string, unknown> | undefined>(tx.objectStore(store).get(0))
	);

/** A PIN row from test-made keys, as the PIN step would leave it (no derive here). */
async function pinRow() {
	const hmac = { name: 'HMAC', hash: 'SHA-256', length: 256 } as const;
	const macKey = await crypto.subtle.generateKey(hmac, false, ['sign', 'verify']);
	const kek = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, [
		'wrapKey',
		'unwrapKey'
	]);
	const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
		'encrypt',
		'decrypt'
	]);
	const hmacKey = await crypto.subtle.generateKey(hmac, true, ['sign', 'verify']);
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

/** Sets a session from the stored PIN row, as the unlock screen does after its derive. */
async function openSession(): Promise<void> {
	const stored = need(await readRaw('keystore')) as unknown as KeystoreRecordPin;
	const k = need(keys);
	setSession(await openPinSession(stored, k, await readCounter(need(db))));
}

/** A device whose keystore is in PIN mode, holding a saved profile when asked; the tab that starts has no session. */
async function pinDevice(withProfile: boolean): Promise<void> {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	const { row, macKey, kek } = await pinRow();
	keys = { macKey, kek };
	await putRaw('keystore', row);
	await openSession();
	await putRaw('profile-hwm', {
		id: 0,
		...(await signSidecar(
			'profile-hwm',
			{ generation: 0, keystoreGeneration: 0, epoch: 0, ts: Date.now() },
			need(getSession()).hmacKey
		))
	});
	if (withProfile) {
		await createProfileStore(db).save({
			eaos: new TextEncoder().encode(EAOS),
			setupIntent: 'completed'
		});
	}
	dropSession();
	harness.db = Promise.resolve(db);
}

async function localDevice(): Promise<void> {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	await createProfileStore(db).save({
		eaos: new TextEncoder().encode(EAOS),
		setupIntent: 'completed'
	});
	harness.db = Promise.resolve(db);
}

/** The layout's app once start-up has finished and its relock seams are wired. */
async function readyApp(): Promise<ProfileApp> {
	await vi.waitFor(() => {
		expect(harness.app?.status).toBe('ready');
		expect(harness.app?.relockAll).not.toBeNull();
		expect(harness.app?.timeline).not.toBeNull();
		expect(harness.app?.calendar).not.toBeNull();
	});
	return need(harness.app);
}

/** The person enters the PIN (a session is set) and the unlock screen asks the app to load every store. */
async function unlock(app: ProfileApp): Promise<void> {
	await openSession();
	await need(app.unlockStores)();
}

/** Settings' Erase: it relocks first, then wipes through the app's own `wipeAll`. */
function settingsErase(app: ProfileApp): Promise<void> {
	return eraseEverything({
		relock: () => app.relockAll?.(),
		wipeAll: app.wipeAll ?? null,
		clearStorage: () => {},
		clearCaches: async () => {},
		reload: () => {}
	});
}

/** The app of a PIN tab that has been unlocked. */
async function unlockedApp(): Promise<ProfileApp> {
	await pinDevice(true);
	await render(Layout, { children });
	const app = await readyApp();
	await unlock(app);
	return app;
}

function holdNavigation() {
	const seen: { type: string; path: string }[] = [];
	const target = (window as unknown as { navigation: EventTarget }).navigation;
	const hold = (e: Event): void => {
		const nav = e as Event & { navigationType: string; destination: { url: string } };
		seen.push({ type: nav.navigationType, path: new URL(nav.destination.url).pathname });
		e.preventDefault();
	};
	target.addEventListener('navigate', hold);
	release = () => target.removeEventListener('navigate', hold);
	return seen;
}

function setHidden(hidden: boolean): void {
	Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => (hidden ? 'hidden' : 'visible')
	});
	document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
	harness.app = null;
	harness.idle.length = 0;
	harness.load = null;
	peer = createProfileBus();
	vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue({} as ServiceWorkerRegistration);
});

afterEach(async () => {
	release?.();
	release = null;
	peer?.close();
	peer = null;
	dropSession();
	setOnSessionMismatch(null);
	delete (document as unknown as Record<string, unknown>).hidden;
	delete (document as unknown as Record<string, unknown>).visibilityState;
	history.replaceState(history.state, '', START_URL);
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
	keys = null;
});

describe('the root layout, opened with a PIN set', () => {
	// Reading would throw into the start-up banner, and a store that never loaded looks like a first run.
	it.each([
		['with a saved profile', true],
		['with no profile mark at all', false]
	])('opens locked and never reads, %s', async (_name, withProfile) => {
		await pinDevice(withProfile);
		await render(Layout, { children });
		const app = await readyApp();

		expect(app.status).toBe('ready');
		expect(app.keyMode).toBe('pin');
		expect(app.pinLocked).toBe(true);
		expect(harness.load?.mock.calls).toEqual([]);
		// Home's setup prompt keys off this, and must never show over a PIN lock.
		expect(app.store?.locked).toBe(true);
		expect(app.timeline?.locked).toBe(true);
		expect(app.calendar?.locked).toBe(true);
		expect(app.store?._getStateForTest()).toBeNull();
	});

	it('does not tell the other tabs it locked, since it only opened', async () => {
		await pinDevice(true);
		const heard: BusSignal[] = [];
		need(peer).subscribe((s) => heard.push(s));
		await render(Layout, { children });
		await readyApp();
		await pause(150);
		expect(heard).toEqual([]);
	});

	it('loads every store once the person has unlocked, and says it is no longer locked', async () => {
		const app = await unlockedApp();

		expect(app.pinLocked).toBe(false);
		expect(app.store?.locked).toBe(false);
		expect(new TextDecoder().decode(app.store?._getStateForTest()?.eaos ?? undefined)).toBe(EAOS);
		expect(app.timeline?.ready).toBe(true);
		expect(app.calendar?.ready).toBe(true);
	});

	// A profile that cannot be read fails closed: no keys and no plaintext stay behind the lock card, and a retry is a fresh
	// unlock rather than a lockout.
	it('fails closed when the profile cannot be read for a reason that is not damage', async () => {
		await pinDevice(true);
		await render(Layout, { children });
		const app = await readyApp();
		// No session: every load is refused.
		await expect(need(app.unlockStores)()).rejects.toThrow(KeystoreLockedError);
		expect(app.pinLocked).toBe(true);
		expect(getSession()).toBeNull();
		expect(app.store?.locked).toBe(true);
		expect(app.status).toBe('ready');
	});
});

describe('the root layout, an unlock that does not go through', () => {
	// Whatever stopped the profile, the person must not be left with keys in memory and a lock card that retries into a
	// lockout.
	it('drops the keys and the plaintext when the profile fails for a reason that is not damage', async () => {
		await pinDevice(true);
		await render(Layout, { children });
		const app = await readyApp();
		await openSession();
		harness.load?.mockRejectedValueOnce(new Error('E_TEST'));

		await expect(need(app.unlockStores)()).rejects.toThrow('E_TEST');

		expect(getSession()).toBeNull();
		expect(app.pinLocked).toBe(true);
		expect(app.store?.locked).toBe(true);
		expect(app.store?._getStateForTest()).toBeNull();
		expect(app.status).toBe('ready');
	});

	/** Flips the last byte of a stored body, the way damage that no key can open looks. */
	async function flipBody(): Promise<Uint8Array> {
		const row = need(await readRaw('profile'));
		const good = row.rec as Uint8Array;
		const rec = new Uint8Array(good);
		rec[rec.length - 1] = (rec[rec.length - 1] ?? 0) ^ 1;
		await putRaw('profile', { ...row, rec });
		return good;
	}

	// The timeline and calendar never block an unlock: the Timeline says its own note, the profile is open.
	it('opens the profile when the timeline cannot be read', async () => {
		await pinDevice(true);
		await putRaw('timeline-state-hwm', {
			id: 0,
			v: 1,
			payload: { generation: 1, keystoreGeneration: 0, epoch: 0, ts: 1 },
			mac: new ArrayBuffer(32)
		});
		await render(Layout, { children });
		const app = await readyApp();

		await unlock(app);

		expect(app.timeline?.failed).toBe(true);
		expect(app.store?._getStateForTest()).not.toBeNull();
		expect(app.pinLocked).toBe(false);
		expect(getSession()).not.toBeNull();
	});

	// A Lock pressed while the unlock is still reading: the lock card must stay up, with no keys behind it.
	it('stays locked when a Lock lands while the other stores are still being read', async () => {
		await pinDevice(true);
		await render(Layout, { children });
		const app = await readyApp();
		vi.spyOn(need(harness.calendar), 'load').mockImplementation(async () => {
			app.relockAll?.();
		});

		await unlock(app);

		expect(app.pinLocked).toBe(true);
		expect(getSession()).toBeNull();
	});

	it('shows the damaged screen when the profile is damaged, and the erase then wipes', async () => {
		await pinDevice(true);
		await flipBody();
		await render(Layout, { children });
		const app = await readyApp();
		const heard: BusSignal[] = [];
		need(peer).subscribe((s) => heard.push(s));

		await openSession();
		await expect(need(app.unlockStores)()).rejects.toThrow();

		expect(getSession()).toBeNull();
		expect(app.store?.locked).toBe(true);
		expect(app.status).toBe('damaged');
		await settingsErase(app);
		expect(await readRaw('keystore')).toBeUndefined();
		expect(getSession()).toBeNull();
		await vi.waitFor(() => expect(heard).toContainEqual({ type: 'keys-changed' }));
	});

	// Another tab may have repaired or replaced the data: nothing is erased on a guess.
	it('does not erase data that reads again, and reloads onto it', async () => {
		await pinDevice(true);
		const good = await flipBody();
		await render(Layout, { children });
		const app = await readyApp();
		await openSession();
		await expect(need(app.unlockStores)()).rejects.toThrow();
		expect(app.status).toBe('damaged');
		const row = need(await readRaw('profile'));
		await putRaw('profile', { ...row, rec: good });
		const seen = holdNavigation();

		await expect(need(app.wipeAll)()).rejects.toThrow('E_NO_LONGER_DAMAGED');

		expect(seen).toHaveLength(1);
		expect(await readRaw('keystore')).toBeDefined();
	});

	// The check holds no key, so a lock on the damaged screen leaves the person's way out intact.
	it('still erases after an idle lock on the damaged screen', async () => {
		await pinDevice(true);
		await flipBody();
		await render(Layout, { children });
		const app = await readyApp();
		await openSession();
		await expect(need(app.unlockStores)()).rejects.toThrow();
		harness.idle[0]?.onIdle();

		await settingsErase(app);

		expect(await readRaw('keystore')).toBeUndefined();
	});

	// Another tab erased, restored or changed the lock while this unlock read: that damage is not this tab's to erase.
	it.each([
		[
			'the keystore row is another install',
			async () => {
				const row = need(await readRaw('keystore'));
				await putRaw('keystore', { ...row, installUuid: new Uint8Array(16).fill(9) });
			}
		],
		['the lock counter moved', async () => void (await bumpCounter(need(db)))]
	])('does not open the damaged screen when %s at the moment of failure', async (_name, change) => {
		await pinDevice(true);
		await render(Layout, { children });
		const app = await readyApp();
		await openSession();
		await change();
		harness.load?.mockRejectedValueOnce(new KeystoreHmacMismatchError());

		await expect(need(app.unlockStores)()).rejects.toThrow(KeystoreHmacMismatchError);

		expect(app.status).toBe('ready');
		expect(getSession()).toBeNull();
		expect(app.pinLocked).toBe(true);
	});

	// A switch away is not a lock: the keys stay, and coming back reads the profile again with no PIN.
	it('keeps the keys when the page is hidden in the last moment of the unlock', async () => {
		await pinDevice(true);
		await render(Layout, { children });
		const app = await readyApp();
		const calendar = need(harness.calendar);
		const read = calendar.load.bind(calendar);
		// Once: the way back re-reads the calendar through the same method.
		vi.spyOn(calendar, 'load').mockImplementationOnce(async () => {
			await read();
			setHidden(true);
		});
		const session = (await openSession(), getSession());

		await need(app.unlockStores)();

		expect(getSession()).toBe(session);
		expect(app.pinLocked).toBe(false);
		expect(app.store?._getStateForTest()).toBeNull();
		setHidden(false);
		await vi.waitFor(() => expect(app.store?._getStateForTest()).not.toBeNull());
		expect(getSession()).toBe(session);
	});
});

describe('the root layout, which relocks drop the keys', () => {
	// A file picker or a share sheet hides the page; the person has not left.
	it('a short switch away drops the plaintext and keeps the keys, so no PIN on the way back', async () => {
		const app = await unlockedApp();
		const session = getSession();

		setHidden(true);
		expect(app.store?._getStateForTest()).toBeNull();
		expect(getSession()).toBe(session);
		setHidden(false);

		await vi.waitFor(() => expect(app.store?._getStateForTest()).not.toBeNull());
		expect(getSession()).toBe(session);
		expect(app.pinLocked).toBe(false);
	});

	const locks: [string, (app: ProfileApp) => unknown][] = [
		["the person's Lock", (app) => app.relockAll?.()],
		['the idle timer', () => harness.idle[0]?.onIdle()],
		["another tab's Lock", () => need(peer).publish({ type: 'relocked', reason: 'user' })],
		['a key change made in another tab', () => need(peer).publish({ type: 'keys-changed' })],
		['an Erase', (app) => app.wipeAll?.()]
	];
	it.each(locks)('%s forgets the keys and shows the PIN lock', async (_name, lock) => {
		const app = await unlockedApp();
		expect(getSession()).not.toBeNull();

		await lock(app);

		await vi.waitFor(() => {
			expect(getSession()).toBeNull();
			expect(app.pinLocked).toBe(true);
		});
		expect(app.store?._getStateForTest()).toBeNull();
	});

	// The other tabs hold keys for rows that are gone; they learn it from this, or from the counter.
	it('an Erase tells the other tabs the keys changed', async () => {
		const app = await unlockedApp();
		const heard: BusSignal[] = [];
		need(peer).subscribe((s) => heard.push(s));

		await app.wipeAll?.();

		await vi.waitFor(() => expect(heard).toContainEqual({ type: 'keys-changed' }));
	});

	// A phone that slept through the timer comes back with a clock far ahead: a PIN tab must be locked before it reads.
	describe('after 16 minutes away', () => {
		const MINUTE = 60_000;
		let skew = 0;
		beforeEach(() => {
			skew = 0;
			const wall = Date.now.bind(Date);
			const mono = performance.now.bind(performance);
			vi.spyOn(Date, 'now').mockImplementation(() => wall() + skew);
			vi.spyOn(performance, 'now').mockImplementation(() => mono() + skew);
		});

		it('a PIN tab forgets the keys and shows the PIN lock when it is shown again', async () => {
			const app = await unlockedApp();
			setHidden(true);
			skew = 16 * MINUTE;
			setHidden(false);

			await vi.waitFor(() => {
				expect(getSession()).toBeNull();
				expect(app.pinLocked).toBe(true);
			});
			expect(app.store?._getStateForTest()).toBeNull();
		});

		it('a tab with no PIN reads its data back with no new tap, as after any short switch away', async () => {
			await localDevice();
			await render(Layout, { children });
			await vi.waitFor(() => expect(harness.app?.store?._getStateForTest()).toBeTruthy());
			const app = need(harness.app);
			setHidden(true);
			expect(app.store?._getStateForTest()).toBeNull();
			skew = 16 * MINUTE;
			setHidden(false);

			await vi.waitFor(() => expect(app.store?._getStateForTest()).not.toBeNull());
			expect(app.store?.locked).toBe(false);
		});
	});

	// A restore replaced the rows, so the keys this tab holds no longer fit them; the reload that follows opens locked.
	it('a restore in another tab forgets the keys and shows the PIN lock before the reload', async () => {
		const app = await unlockedApp();
		const seen = holdNavigation();

		need(peer).publish({ type: 'data-replaced' });

		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(getSession()).toBeNull();
		expect(app.pinLocked).toBe(true);
	});

	// A tab asleep in the back/forward cache and a tab with no BroadcastChannel hear of a Lock through this alone.
	it("the person's Lock changes the lock counter", async () => {
		const app = await unlockedApp();
		const before = await readCounter(need(db));
		app.relockAll?.();
		await vi.waitFor(async () => expect(await readCounter(need(db))).not.toBe(before));
	});

	it('the idle lock leaves the lock counter alone', async () => {
		const app = await unlockedApp();
		const before = await readCounter(need(db));
		harness.idle[0]?.onIdle();
		await vi.waitFor(() => expect(app.pinLocked).toBe(true));
		await pause(100);
		expect(await readCounter(need(db))).toBe(before);
	});

	// Another tab's idle is not this person leaving: with a PIN, only Lock and key changes reach the other tabs.
	it('an idle lock does not reach the other tabs with a PIN set', async () => {
		const app = await unlockedApp();
		const heard: BusSignal[] = [];
		need(peer).subscribe((s) => heard.push(s));
		harness.idle[0]?.onIdle();
		await vi.waitFor(() => expect(app.pinLocked).toBe(true));
		await pause(150);
		expect(heard).toEqual([]);
	});

	it('an idle lock still reaches the other tabs without a PIN, as it always did', async () => {
		await localDevice();
		const heard: BusSignal[] = [];
		need(peer).subscribe((s) => heard.push(s));
		await render(Layout, { children });
		await vi.waitFor(() => expect(harness.app?.status).toBe('ready'));
		harness.idle[0]?.onIdle();
		await vi.waitFor(() =>
			expect(heard).toContainEqual({ type: 'relocked', reason: 'idle' } satisfies BusSignal)
		);
	});

	it('does not drop the keys in a tab with no PIN, where there are none', async () => {
		await localDevice();
		await render(Layout, { children });
		await vi.waitFor(() => expect(harness.app?.status).toBe('ready'));
		const app = need(harness.app);
		expect(app.keyMode ?? 'local').toBe('local');
		app.relockAll?.();
		await pause(50);
		expect(app.pinLocked ?? false).toBe(false);
	});
});

describe('the root layout, a tab that missed a Lock', () => {
	it('a tab restored from the back/forward cache refuses the re-read after a Lock made elsewhere', async () => {
		const app = await unlockedApp();
		// The timeline and calendar re-reads refuse on a moved counter too and would drop the session first; they wait,
		// so that it is the profile's own check that is shown to refuse.
		let open = (): void => {};
		const gate = new Promise<void>((resolve) => (open = resolve));
		vi.spyOn(need(harness.timeline), 'load').mockImplementation(() => gate);
		vi.spyOn(need(harness.calendar), 'load').mockImplementation(() => gate);
		const reads = need(harness.load).mock.results.length;
		// Another tab's Lock reaches the tab asleep in the cache only as this counter.
		await bumpCounter(need(db));

		window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

		const reread = need(harness.load).mock.results[reads]?.value;
		await expect(reread).rejects.toThrow(KeystoreLockedError);
		open();
		await vi.waitFor(() => {
			expect(getSession()).toBeNull();
			expect(app.pinLocked).toBe(true);
		});
		expect(app.store?._getStateForTest()).toBeNull();
	});
});

describe('every other key read, with a live session', () => {
	it('a backup snapshot refuses after the lock counter moved, and drops the session', async () => {
		await pinDevice(true);
		await openSession();
		expect((await takeSnapshot(need(db))).ok).toBe(true);
		await bumpCounter(need(db));

		const snap = await takeSnapshot(need(db));

		expect(snap).toMatchObject({ ok: false, code: 'E_SNAPSHOT_FAILED' });
		expect(getSession()).toBeNull();
	});

	it('the device-state read refuses after the lock counter moved, and drops the session', async () => {
		await pinDevice(true);
		await openSession();
		expect((await readDeviceState(need(db))).gens.profile).toBe(1);
		await bumpCounter(need(db));

		await expect(readDeviceState(need(db))).rejects.toThrow(KeystoreLockedError);

		expect(getSession()).toBeNull();
	});
});

describe("the profile store's own reads, with a live session", () => {
	// save() reads the row inside its own transaction, so it does not go through the check the other stores' reads do. (The
	// load's own check is shown by the back/forward cache case above.)
	it('save refuses after the lock counter moved, and drops the session', async () => {
		await pinDevice(true);
		await openSession();
		await bumpCounter(need(db));
		await expect(createProfileStore(need(db)).save({})).rejects.toThrow(KeystoreLockedError);
		expect(getSession()).toBeNull();
	});
});

describe('the root layout, when another tab changes the keys', () => {
	/** Replaces the stored row the way a Remove PIN (a local row) or an Erase (none) leaves it. */
	async function replaceRow(kind: 'local' | 'none'): Promise<void> {
		await withStores(need(db), 'keystore', 'readwrite', (tx) => {
			tx.objectStore('keystore').delete(0);
		});
		if (kind === 'local') await bootstrapLocalKeystore(need(db));
	}

	it.each([
		['a local row', 'local' as const],
		['no row', 'none' as const]
	])('a PIN-locked tab that finds %s reloads', async (_name, kind) => {
		await pinDevice(true);
		await render(Layout, { children });
		const app = await readyApp();
		const seen = holdNavigation();
		await replaceRow(kind);

		need(peer).publish({ type: 'keys-changed' });

		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]?.type).toBe('reload');
		expect(app.keyMode).toBe('local');
	});

	// A reload starts the app over on a local row and so decrypts: a tab nobody can see waits until it is shown.
	it('a hidden PIN-locked tab that finds a local row reloads only once it is shown', async () => {
		await pinDevice(true);
		await render(Layout, { children });
		await readyApp();
		const seen = holdNavigation();
		setHidden(true);
		await replaceRow('local');

		need(peer).publish({ type: 'keys-changed' });
		await pause(200);
		expect(seen).toEqual([]);

		setHidden(false);
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]?.type).toBe('reload');
	});

	// Change PIN leaves a PIN row: the tab stays locked and asks for the new PIN, where a reload would gain nothing.
	it('a PIN-locked tab that finds a PIN row stays locked and does not reload', async () => {
		await pinDevice(true);
		await render(Layout, { children });
		const app = await readyApp();
		const seen = holdNavigation();

		need(peer).publish({ type: 'keys-changed' });
		await pause(200);

		expect(seen).toEqual([]);
		expect(app.keyMode).toBe('pin');
		expect(app.pinLocked).toBe(true);
	});

	it('a tab with no PIN learns that one was set, and locks', async () => {
		await localDevice();
		await render(Layout, { children });
		await vi.waitFor(() => expect(harness.app?.store?._getStateForTest()).toBeTruthy());
		const app = need(harness.app);

		const { row } = await pinRow();
		await putRaw('keystore', row);
		need(peer).publish({ type: 'keys-changed' });

		await vi.waitFor(() => {
			expect(app.keyMode).toBe('pin');
			expect(app.pinLocked).toBe(true);
		});
		expect(app.store?._getStateForTest()).toBeNull();
	});
});
