import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
	initProfileApp,
	installLifecycle,
	provisionStore,
	createRelockEcho,
	relockAll,
	reloadWhenShown,
	superviseStartup,
	START_TIMEOUT_MS,
	type AppInitResult
} from './app-init';
import { KeystoreAlreadyExistsError } from '../keystore/bootstrap';
import { KeystoreHmacMismatchError } from './store.svelte';
import { LockAcquisitionTimeout } from '../db/locks';
import { getDiagnosticsForTest } from '../log/safelog';
import type { AppStatus } from './context';
import type { IdleTimer } from './idle-timer';
import type { BusSignal, ProfileBus } from '../broadcast/bus';

const fakeDb = {} as IDBDatabase;
const makeStore = () => ({ load: vi.fn().mockResolvedValue(null), relockSync: vi.fn() });

function recordingBus(): { bus: ProfileBus; sent: BusSignal[] } {
	const sent: BusSignal[] = [];
	return {
		sent,
		bus: { publish: (s) => sent.push(s), subscribe: () => () => {}, close: () => {} }
	};
}

describe('relockAll', () => {
	const profileLike = () => ({
		relockSync: vi.fn(),
		refresh: vi.fn().mockResolvedValue(null),
		lock: vi.fn().mockResolvedValue(undefined)
	});
	const secondaryLike = () => ({ relockSync: vi.fn(), refresh: vi.fn().mockResolvedValue(null) });

	it('relocks EVERY store, not just the first', () => {
		// The regression this exists to prevent: the erase and the Settings Lock each enumerated their
		// own relock set and both enumerated only the profile, leaving the timeline's decrypted
		// free-text notes resident in memory. There is one list; this is the only way to walk it.
		const profile = profileLike();
		const timeline = secondaryLike();
		const calendar = secondaryLike();

		relockAll([profile, timeline, calendar], 'user');

		expect(profile.lock).toHaveBeenCalledOnce();
		expect(timeline.relockSync).toHaveBeenCalledOnce();
		expect(calendar.relockSync).toHaveBeenCalledOnce();
	});

	it('passes the reason through to every store, however each one relocks', () => {
		// Three sources converge here - the idle timer, the Lock button, the erase - and the reason
		// is the only thing that tells a later page restore whether it may undo this. Dropping it on
		// the way through is how the restore came to undo an explicit Lock.
		const profile = profileLike();
		const timeline = secondaryLike();

		relockAll([profile, timeline], 'idle');

		expect(profile.lock).toHaveBeenCalledWith('idle');
		expect(timeline.relockSync).toHaveBeenCalledWith('idle');
	});

	it('prefers lock() where a store has one, so an in-flight save is not interrupted', () => {
		const profile = profileLike();
		relockAll([profile], 'user');
		// The profile defers its relock past an in-flight encrypt/write; the secondaries have no save
		// to interrupt and drop synchronously.
		expect(profile.lock).toHaveBeenCalledOnce();
		expect(profile.relockSync).not.toHaveBeenCalled();
	});

	it('relocks the remaining stores even when one throws', () => {
		const boom = {
			relockSync: vi.fn(() => {
				throw new Error('relock blew up');
			}),
			refresh: vi.fn()
		};
		const after = secondaryLike();
		// A store failing to relock must not strand PII in every store after it in the list.
		expect(() => relockAll([boom, after], 'user')).not.toThrow();
		expect(after.relockSync).toHaveBeenCalledOnce();
	});
});

describe('createRelockEcho', () => {
	it('publishes a locally-initiated relock', () => {
		const { bus, sent } = recordingBus();
		const echo = createRelockEcho(bus);
		echo.publish({ type: 'relocked' });
		expect(sent).toEqual([{ type: 'relocked' }]);
	});

	it('does NOT re-publish relocks raised while answering a peer', () => {
		const { bus, sent } = recordingBus();
		const echo = createRelockEcho(bus);
		// Every store signals on relock, and every tab relocks every store on an inbound signal. If
		// the answer re-signals, each hop multiplies by (stores x tabs) and the channel saturates.
		echo.answer(() => {
			echo.publish({ type: 'relocked' });
			echo.publish({ type: 'relocked' });
			echo.publish({ type: 'relocked' });
		});
		expect(sent).toEqual([]);
	});

	it('still publishes non-relock signals while answering', () => {
		const { bus, sent } = recordingBus();
		const echo = createRelockEcho(bus);
		echo.answer(() => {
			echo.publish({ type: 'timeline-updated' });
			echo.publish({ type: 'relocked' });
		});
		expect(sent).toEqual([{ type: 'timeline-updated' }]);
	});

	it('resumes publishing after the answer completes, even if it throws', () => {
		const { bus, sent } = recordingBus();
		const echo = createRelockEcho(bus);
		expect(() =>
			echo.answer(() => {
				throw new Error('a store blew up mid-relock');
			})
		).toThrow('a store blew up mid-relock');
		// A throw inside one store's relock must not wedge the seam shut for the tab's whole life.
		echo.publish({ type: 'relocked' });
		expect(sent).toEqual([{ type: 'relocked' }]);
	});
});

describe('initProfileApp', () => {
	it('returns unsupported with the cause when the capability gate fails', async () => {
		const openDb = vi.fn(async () => fakeDb);
		const result = await initProfileApp({
			checkSupport: async () => ({ ok: false, cause: 'indexed-db' }),
			openDb,
			bootstrap: vi.fn(async () => ({})),
			createStore: () => makeStore()
		});
		expect(result).toEqual({ status: 'unsupported', cause: 'indexed-db' });
		// fail-closed: nothing past the gate runs
		expect(openDb).not.toHaveBeenCalled();
	});

	// Damaged saved data is named, with the open database, so the app can offer to erase it; a reload would fail the same
	// way. Any other load failure still rejects, so data that may be fine is never offered for erase.
	it('names a load that fails on damaged saved data, and hands back the open database', async () => {
		const store = { load: vi.fn().mockRejectedValue(new KeystoreHmacMismatchError()) };
		const result = await initProfileApp({
			checkSupport: async () => ({ ok: true }),
			openDb: async () => fakeDb,
			bootstrap: vi.fn(async () => {
				throw new KeystoreAlreadyExistsError();
			}),
			createStore: () => store
		});
		expect(result).toEqual({ status: 'damaged', db: fakeDb });
	});

	it('rejects a load that fails for any other reason', async () => {
		const store = { load: vi.fn().mockRejectedValue(new LockAcquisitionTimeout()) };
		await expect(
			initProfileApp({
				checkSupport: async () => ({ ok: true }),
				openDb: async () => fakeDb,
				bootstrap: vi.fn(async () => {
					throw new KeystoreAlreadyExistsError();
				}),
				createStore: () => store
			})
		).rejects.toThrow(LockAcquisitionTimeout);
	});

	it('first run: bootstraps, creates the store, loads, returns ready', async () => {
		const store = makeStore();
		const bootstrap = vi.fn(async () => ({ record: {} }));
		const result = await initProfileApp({
			checkSupport: async () => ({ ok: true }),
			openDb: async () => fakeDb,
			bootstrap,
			createStore: () => store
		});
		expect(bootstrap).toHaveBeenCalledWith(fakeDb);
		expect(store.load).toHaveBeenCalledTimes(1);
		expect(result.status).toBe('ready');
		if (result.status === 'ready') {
			expect(result.store).toBe(store);
			expect(result.db).toBe(fakeDb);
		}
	});

	it('returning user: swallows KeystoreAlreadyExistsError and still returns ready', async () => {
		const store = makeStore();
		const result = await initProfileApp({
			checkSupport: async () => ({ ok: true }),
			openDb: async () => fakeDb,
			bootstrap: async () => {
				throw new KeystoreAlreadyExistsError();
			},
			createStore: () => store
		});
		expect(result.status).toBe('ready');
		expect(store.load).toHaveBeenCalledTimes(1);
	});

	it('rethrows a non-KeystoreAlreadyExists bootstrap error', async () => {
		await expect(
			initProfileApp({
				checkSupport: async () => ({ ok: true }),
				openDb: async () => fakeDb,
				bootstrap: async () => {
					throw new Error('disk full');
				},
				createStore: () => makeStore()
			})
		).rejects.toThrow('disk full');
	});
});

describe('provisionStore', () => {
	it('creates the store from the db and loads it', async () => {
		const store = makeStore();
		const make = vi.fn(() => store);
		const result = await provisionStore(fakeDb, make);
		expect(make).toHaveBeenCalledWith(fakeDb);
		expect(store.load).toHaveBeenCalledTimes(1);
		expect(result).toBe(store);
	});

	// load() decrypts. Handing the store over only after it resolves leaves a window where the
	// plaintext is in memory but the store is in nobody's relock list - so a page hidden during
	// startup zeroizes every store except the one that just finished reading the user's notes.
	it('hands the store over before it decrypts, not after', async () => {
		const order: string[] = [];
		const store = { load: vi.fn(async () => void order.push('load')), relockSync: vi.fn() };
		await provisionStore(
			fakeDb,
			() => store,
			() => order.push('joined the relock set')
		);
		expect(order).toEqual(['joined the relock set', 'load']);
	});

	// load() ignores how the plaintext went away, so a store whose first read finishes after the page was hidden
	// holds decrypted data in a hidden tab, and the hide event it should have answered is already past.
	it('relocks as hygiene after a first read that finished while the page is hidden', async () => {
		const order: string[] = [];
		const store = {
			load: vi.fn(async () => void order.push('load')),
			relockSync: vi.fn((reason: string) => void order.push('relock ' + reason))
		};
		await provisionStore(
			fakeDb,
			() => store,
			undefined,
			() => true
		);
		expect(order).toEqual(['load', 'relock hygiene']);
	});

	it('leaves a store loaded while the page is shown', async () => {
		const store = makeStore();
		await provisionStore(
			fakeDb,
			() => store,
			undefined,
			() => false
		);
		expect(store.relockSync).not.toHaveBeenCalled();
	});
});

describe('installLifecycle when the page is already hidden', () => {
	const timer: IdleTimer = { start: vi.fn(), stop: vi.fn(), recordActivity: vi.fn() };
	function install(hidden: boolean) {
		const a = { relockSync: vi.fn(), refresh: vi.fn().mockResolvedValue(null) };
		const b = { relockSync: vi.fn(), refresh: vi.fn().mockResolvedValue(null) };
		installLifecycle([a, b], {
			win: new EventTarget(),
			doc: new EventTarget(),
			isHidden: () => hidden,
			createIdleTimer: () => timer,
			idleThresholdMs: 900_000
		});
		return [a, b];
	}

	// The visibilitychange that hid the page fired before these listeners existed, so nothing else would ever answer it.
	it('relocks every store as hygiene once at install, and never re-reads', () => {
		for (const s of install(true)) {
			expect(s.relockSync).toHaveBeenCalledExactlyOnceWith('hygiene');
			expect(s.refresh).not.toHaveBeenCalled();
		}
	});

	it('leaves the stores alone when the page is shown', () => {
		for (const s of install(false)) {
			expect(s.relockSync).not.toHaveBeenCalled();
			expect(s.refresh).not.toHaveBeenCalled();
		}
	});
});

describe('reloadWhenShown', () => {
	function setup(hidden: boolean) {
		let handler: ((s: BusSignal) => void) | undefined;
		const unsubscribe = vi.fn(() => void (handler = undefined));
		const bus: ProfileBus = {
			publish: () => {},
			subscribe: (h) => {
				handler = h;
				return unsubscribe;
			},
			close: () => {}
		};
		const doc = Object.assign(new EventTarget(), { hidden });
		const reload = vi.fn();
		const stop = reloadWhenShown(bus, doc, reload);
		return {
			reload,
			stop,
			signal: () => handler?.({ type: 'relocked' }),
			show: () => {
				doc.hidden = false;
				doc.dispatchEvent(new Event('visibilitychange'));
			}
		};
	}

	// A reload runs the start-up again, which decrypts whatever another tab left behind; in a hidden tab
	// that would put plaintext in the heap of a page nobody is looking at.
	it('holds the reload while hidden, then reloads once when shown', () => {
		const t = setup(true);
		t.signal();
		expect(t.reload).not.toHaveBeenCalled();
		t.show();
		expect(t.reload).toHaveBeenCalledTimes(1);
		t.show();
		expect(t.reload).toHaveBeenCalledTimes(1);
	});

	// Another tab's erase and fresh setup send several signals in a row; the hidden tab must still reload once.
	it('reloads once for a burst of signals that arrived while hidden', () => {
		const t = setup(true);
		t.signal();
		t.signal();
		t.signal();
		t.show();
		expect(t.reload).toHaveBeenCalledTimes(1);
	});

	it('reloads at once when the page is shown', () => {
		const t = setup(false);
		t.signal();
		expect(t.reload).toHaveBeenCalledTimes(1);
	});

	it('does nothing after teardown, whether the reload was waiting or not', () => {
		const t = setup(true);
		t.signal();
		t.stop();
		t.show();
		t.signal();
		expect(t.reload).not.toHaveBeenCalled();
	});
});

describe('superviseStartup', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function harness(initial: AppStatus = 'loading') {
		const app = { status: initial };
		let settle!: (r: AppInitResult<ReturnType<typeof makeStore>>) => void;
		let fail!: () => void;
		const start = new Promise<AppInitResult<ReturnType<typeof makeStore>>>((resolve, reject) => {
			settle = resolve;
			fail = () => reject(new Error('E_TEST'));
		});
		const db = { close: vi.fn() };
		const onResult = vi.fn();
		let blocked!: () => void;
		const cancel = superviseStartup(
			(onBlocked) => {
				blocked = onBlocked;
				return start;
			},
			app,
			onResult
		);
		const ready = (store = makeStore()) =>
			settle({ status: 'ready', store, db: db as unknown as IDBDatabase });
		return {
			status: () => app.status,
			setStatus: (s: AppStatus) => (app.status = s),
			db,
			onResult,
			blocked,
			cancel,
			settle,
			fail,
			ready
		};
	}

	it('shows the banner status once the start-up outlasts its timeout, not before', async () => {
		const h = harness();
		await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS - 1);
		expect(h.status()).toBe('loading');
		await vi.advanceTimersByTimeAsync(1);
		expect(h.status()).toBe('error');
	});

	it('recovers by itself when the slow start-up later succeeds', async () => {
		const h = harness();
		await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
		h.ready();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.status()).toBe('ready');
		expect(h.onResult).toHaveBeenCalledOnce();
	});

	it('shows the erase offer when the slow start-up later finds the data damaged', async () => {
		const h = harness();
		await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
		h.settle({ status: 'damaged', db: h.db as unknown as IDBDatabase });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.status()).toBe('damaged');
		expect(h.onResult).toHaveBeenCalledOnce();
	});

	// Another tab holds an older connection open: the open waits, and the banner says so at once instead of at the
	// timeout. When that tab closes the same open succeeds, and the app opens without a Reload.
	it('shows the banner status when the open is blocked, then opens when it succeeds', async () => {
		const h = harness();
		h.blocked();
		expect(h.status()).toBe('error');
		h.ready();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.status()).toBe('ready');
		expect(h.onResult).toHaveBeenCalledOnce();
	});

	it('keeps a takeover over a blocked open', () => {
		const h = harness('stale');
		h.blocked();
		expect(h.status()).toBe('stale');
	});

	it('does not replace a takeover with the timeout', async () => {
		const h = harness();
		h.setStatus('stale');
		await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
		expect(h.status()).toBe('stale');
	});

	it('clears the timer when the start-up settles, by result or by failure', async () => {
		const done = harness();
		done.ready();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
		const failed = harness();
		failed.fail();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('shows the banner status and logs an opaque code when the start-up fails', async () => {
		const h = harness();
		const logged = getDiagnosticsForTest().length;
		h.fail();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.status()).toBe('error');
		expect(
			getDiagnosticsForTest()
				.slice(logged)
				.map((e) => e.code)
		).toEqual(['E_INIT_FAILED']);
	});

	it('keeps a takeover over a failure', async () => {
		const stale = harness('stale');
		stale.fail();
		await vi.advanceTimersByTimeAsync(0);
		expect(stale.status()).toBe('stale');
	});

	it('clears the timer on teardown', () => {
		const h = harness();
		expect(vi.getTimerCount()).toBe(1);
		h.cancel();
		expect(vi.getTimerCount()).toBe(0);
	});

	// The tab went stale (or cannot run) while the start-up was loading: nothing is wired, so nothing may stay
	// decrypted, and the connection is released.
	it('zeroizes the loaded store and closes the database when the tab went stale meanwhile', async () => {
		const h = harness();
		const store = makeStore();
		h.setStatus('stale');
		h.ready(store);
		await vi.advanceTimersByTimeAsync(0);
		expect(store.relockSync).toHaveBeenCalledExactlyOnceWith('hygiene');
		expect(h.db.close).toHaveBeenCalledOnce();
		expect(h.onResult).not.toHaveBeenCalled();
		expect(h.status()).toBe('stale');
	});

	it('closes the database of damaged data found after the tab went stale', async () => {
		const h = harness('stale');
		h.settle({ status: 'damaged', db: h.db as unknown as IDBDatabase });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.db.close).toHaveBeenCalledOnce();
		expect(h.onResult).not.toHaveBeenCalled();
		expect(h.status()).toBe('stale');
	});

	it('hands an unsupported result over untouched', async () => {
		const h = harness('error');
		h.settle({ status: 'unsupported', cause: 'indexed-db' });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.status()).toBe('unsupported');
		expect(h.onResult).toHaveBeenCalledOnce();
	});
});
