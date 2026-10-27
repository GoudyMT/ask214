import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
	initProfileApp,
	installLifecycle,
	provisionStore,
	createRelockEcho,
	relockAll,
	relockEachSync,
	createJoinRelock,
	reloadWhenShown,
	reloadOnSignalWhenShown,
	subscribeBus,
	superviseStartup,
	START_TIMEOUT_MS,
	type AppInitResult,
	type Relockable
} from './app-init';
import { IDLE_THRESHOLD_MS } from './idle-threshold';
import { KeystoreAlreadyExistsError } from '../keystore/bootstrap';
import { KeystoreHmacMismatchError } from './store.svelte';
import { LockAcquisitionTimeout } from '../db/locks';
import { getDiagnosticsForTest } from '../log/safelog';
import type { AppStatus } from './context';
import { createIdleTimer, type IdleTimer } from './idle-timer';
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

describe('walking the relock list', () => {
	const timer: IdleTimer = {
		start: vi.fn(),
		stop: vi.fn(),
		recordActivity: vi.fn(),
		quietMs: () => 0
	};
	const fake = () => ({ relockSync: vi.fn(), refresh: vi.fn().mockResolvedValue(null) });
	const throwing = () => ({
		relockSync: vi.fn(() => {
			throw new Error('relock blew up');
		}),
		refresh: vi.fn().mockResolvedValue(null)
	});

	function install(relockables: Relockable[]) {
		const win = new EventTarget();
		const doc = new EventTarget();
		installLifecycle(relockables, {
			win,
			doc,
			isHidden: () => false,
			createIdleTimer: () => timer,
			idleThresholdMs: 900_000
		});
		return { win, doc };
	}

	it('relockEachSync relocks every store when one throws', () => {
		const a = fake();
		const boom = throwing();
		const c = fake();
		expect(() => relockEachSync([a, boom, c], 'peer')).not.toThrow();
		expect(a.relockSync).toHaveBeenCalledExactlyOnceWith('peer');
		expect(boom.relockSync).toHaveBeenCalledExactlyOnceWith('peer');
		expect(c.relockSync).toHaveBeenCalledExactlyOnceWith('peer');
	});

	it('relockEachSync passes the detail to every relockable', () => {
		const a = fake();
		const boom = throwing();
		const c = fake();
		relockEachSync([a, boom, c], 'peer', { peerReason: 'user' });
		expect(a.relockSync).toHaveBeenCalledExactlyOnceWith('peer', { peerReason: 'user' });
		expect(boom.relockSync).toHaveBeenCalledExactlyOnceWith('peer', { peerReason: 'user' });
		expect(c.relockSync).toHaveBeenCalledExactlyOnceWith('peer', { peerReason: 'user' });
	});

	it('onHide relocks every store when one throws', () => {
		const a = fake();
		const boom = throwing();
		const c = fake();
		const { win } = install([a, boom, c]);
		win.dispatchEvent(new Event('pagehide'));
		expect(c.relockSync).toHaveBeenCalledExactlyOnceWith('hygiene');
	});

	// A store that leaves the shared list during its own relock shifts every later index by one, so a walk
	// over the live array skips the store right after it.
	const walkers: [string, (list: Relockable[]) => void][] = [
		['relockAll', (list) => relockAll(list, 'user')],
		['relockEachSync', (list) => relockEachSync(list, 'peer')],
		['onHide', (list) => install(list).win.dispatchEvent(new Event('pagehide'))]
	];
	it.each(walkers)(
		'%s: a relockable that leaves during the walk does not make the walk skip the next one',
		(_name, walk) => {
			const list: Relockable[] = [];
			const a = {
				relockSync: vi.fn(() => void list.splice(list.indexOf(a), 1)),
				refresh: vi.fn().mockResolvedValue(null)
			};
			const b = fake();
			list.push(a, b);
			walk(list);
			expect(a.relockSync).toHaveBeenCalledOnce();
			expect(b.relockSync).toHaveBeenCalledOnce();
		}
	);

	it('restore re-reads every store when one refresh throws synchronously', () => {
		const a = fake();
		const boom = {
			relockSync: vi.fn(),
			refresh: vi.fn(() => {
				throw new Error('refresh blew up');
			})
		};
		const c = fake();
		const { doc } = install([a, boom, c]);
		doc.dispatchEvent(new Event('resume'));
		expect(a.refresh).toHaveBeenCalledOnce();
		expect(boom.refresh).toHaveBeenCalledOnce();
		expect(c.refresh).toHaveBeenCalledOnce();
	});
});

describe('createJoinRelock', () => {
	const fake = () => ({ relockSync: vi.fn(), refresh: vi.fn().mockResolvedValue(null) });

	it('a joined relockable is relocked by the walk over the list', () => {
		const list: Relockable[] = [];
		const joiner = fake();
		createJoinRelock(list)(joiner);
		relockEachSync(list, 'peer');
		expect(joiner.relockSync).toHaveBeenCalledExactlyOnceWith('peer');
	});

	// A joiner must receive every argument after the reason, so a detail a walk passes reaches it.
	it('forwards every argument after the reason to the joiner', () => {
		const list: Relockable[] = [];
		const joiner = fake();
		createJoinRelock(list)(joiner);
		const entry = list[0];
		if (!entry) throw new Error('test setup: no entry joined');
		entry.relockSync('peer', { peerReason: 'idle' });
		expect(joiner.relockSync).toHaveBeenCalledExactlyOnceWith('peer', { peerReason: 'idle' });
	});

	it('a joined relockable receives the detail', () => {
		const list: Relockable[] = [];
		const joiner = fake();
		createJoinRelock(list)(joiner);
		relockEachSync(list, 'peer', { peerReason: 'idle' });
		expect(joiner.relockSync).toHaveBeenCalledExactlyOnceWith('peer', { peerReason: 'idle' });
	});

	it('a joiner that throws does not stop the walk', () => {
		const first = fake();
		const last = fake();
		const boom = {
			relockSync: vi.fn(() => {
				throw new Error('relock blew up');
			}),
			refresh: vi.fn().mockResolvedValue(null)
		};
		const list: Relockable[] = [first];
		createJoinRelock(list)(boom);
		list.push(last);
		// The wrapper swallows the throw itself, so even a walk that has no isolation of its own gets through.
		expect(() => {
			for (const r of list) r.relockSync('user');
		}).not.toThrow();
		expect(boom.relockSync).toHaveBeenCalledOnce();
		expect(first.relockSync).toHaveBeenCalledOnce();
		expect(last.relockSync).toHaveBeenCalledOnce();
	});

	// A lifecycle restore must reach the joiner's own refresh: the backup session un-conceals there.
	it('the joined entry forwards its refresh to the joiner', async () => {
		const list: Relockable[] = [];
		const joiner = fake();
		createJoinRelock(list)(joiner);
		expect(list).toHaveLength(1);
		await list[0]?.refresh();
		expect(joiner.refresh).toHaveBeenCalledOnce();
	});

	// restore() walks every store; a joiner whose refresh throws or rejects must not stop the walk or surface.
	it.each([
		[
			'throws synchronously',
			() => {
				throw new Error('refresh blew up');
			}
		],
		['rejects', () => Promise.reject(new Error('refresh rejected'))]
	])('a joiner whose refresh %s settles quietly', async (_name, refresh) => {
		const list: Relockable[] = [];
		createJoinRelock(list)({ relockSync: vi.fn(), refresh });
		await expect(list[0]?.refresh()).resolves.toBeUndefined();
	});

	it.each([
		['first in, first out', 0, 1],
		['last in, first out', 1, 0]
	])('leave() removes exactly that entry (%s)', (_name, firstLeaver, secondLeaver) => {
		const list: Relockable[] = [];
		const join = createJoinRelock(list);
		const a = fake();
		const b = fake();
		const leaves = [join(a), join(b)];
		expect(list).toHaveLength(2);

		leaves[firstLeaver]?.();
		expect(list).toHaveLength(1);
		relockEachSync(list, 'user');
		const stayer = firstLeaver === 0 ? b : a;
		const gone = firstLeaver === 0 ? a : b;
		expect(stayer.relockSync).toHaveBeenCalledOnce();
		expect(gone.relockSync).not.toHaveBeenCalled();

		leaves[secondLeaver]?.();
		expect(list).toHaveLength(0);
	});

	it('leave() twice removes nothing more', () => {
		const list: Relockable[] = [];
		const join = createJoinRelock(list);
		const a = fake();
		const b = fake();
		const leaveA = join(a);
		join(b);
		leaveA();
		leaveA();
		expect(list).toHaveLength(1);
		relockEachSync(list, 'user');
		expect(b.relockSync).toHaveBeenCalledOnce();
		expect(a.relockSync).not.toHaveBeenCalled();
	});
});

describe('IDLE_THRESHOLD_MS', () => {
	it('is 15 minutes', () => {
		expect(IDLE_THRESHOLD_MS).toBe(15 * 60 * 1000);
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
	const timer: IdleTimer = {
		start: vi.fn(),
		stop: vi.fn(),
		recordActivity: vi.fn(),
		quietMs: () => 0
	};
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

// A phone that sleeps runs no timer, so the way back is the only moment the app can notice how long it was gone. These
// tests move injected clocks and never advance a timer, which is exactly that sleep.
describe('installLifecycle, coming back after time away', () => {
	const MINUTE = 60_000;
	const THRESHOLD = IDLE_THRESHOLD_MS;
	type WayName = 'a persisted pageshow' | 'resume' | 'becoming visible';

	function setup(opts: { hiddenAtStart?: boolean; realTimer?: boolean } = {}) {
		const clock = { wall: 1_700_000_000_000, perf: 50_000 };
		const order: string[] = [];
		const store = {
			relockSync: vi.fn((reason: string) => void order.push('relockSync ' + reason)),
			refresh: vi.fn(() => {
				order.push('refresh');
				return Promise.resolve(null);
			}),
			lock: vi.fn((reason: string) => {
				order.push('lock ' + reason);
				return Promise.resolve();
			})
		};
		const timer: IdleTimer = {
			start: vi.fn(() => void order.push('timer start')),
			stop: vi.fn(),
			recordActivity: vi.fn(),
			quietMs: () => 0
		};
		const win = new EventTarget();
		const doc = new EventTarget();
		let hidden = opts.hiddenAtStart ?? false;
		const off = installLifecycle([store], {
			win,
			doc,
			isHidden: () => hidden,
			createIdleTimer: opts.realTimer ? createIdleTimer : () => timer,
			idleThresholdMs: THRESHOLD,
			now: () => clock.wall,
			perfNow: () => clock.perf
		});
		const pageshow = () => {
			const e = new Event('pageshow');
			Object.defineProperty(e, 'persisted', { value: true });
			win.dispatchEvent(e);
		};
		const ways: Record<WayName, { hide: () => void; back: () => void }> = {
			'a persisted pageshow': {
				hide: () => win.dispatchEvent(new Event('pagehide')),
				back: pageshow
			},
			resume: {
				hide: () => doc.dispatchEvent(new Event('freeze')),
				back: () => doc.dispatchEvent(new Event('resume'))
			},
			'becoming visible': {
				hide: () => {
					hidden = true;
					doc.dispatchEvent(new Event('visibilitychange'));
				},
				back: () => {
					hidden = false;
					doc.dispatchEvent(new Event('visibilitychange'));
				}
			}
		};
		return {
			clock,
			order,
			store,
			timer,
			win,
			doc,
			ways,
			off,
			away: (wallMs: number, perfMs: number = wallMs) => {
				clock.wall += wallMs;
				clock.perf += perfMs;
			}
		};
	}
	const WAY_NAMES: WayName[] = ['a persisted pageshow', 'resume', 'becoming visible'];

	// With a PIN or without one: a long absence is shut before anything is read again.
	describe.each(WAY_NAMES)('%s', (name) => {
		it('relocks as idle before any re-read after 16 minutes away', () => {
			const t = setup();
			const way = t.ways[name];
			way.hide();
			t.order.length = 0;
			t.away(16 * MINUTE);
			way.back();
			expect(t.order).toEqual(['lock idle', 'refresh', 'timer start']);
		});

		it('only re-reads after 14 minutes away', () => {
			const t = setup();
			const way = t.ways[name];
			way.hide();
			t.order.length = 0;
			t.away(14 * MINUTE);
			way.back();
			expect(t.order).toEqual(['refresh']);
		});
	});

	// Phone clocks are set by hand and by the network; either clock alone can be wrong, so the longer reading wins.
	it.each([
		['the wall clock moved back an hour', -60 * MINUTE, 1 * MINUTE, true],
		['only the monotonic clock passed the threshold', 1 * MINUTE, 16 * MINUTE, true],
		['only the wall clock passed the threshold', 16 * MINUTE, 1 * MINUTE, true],
		['exactly the threshold passed', THRESHOLD, THRESHOLD, true],
		['one millisecond under the threshold passed', THRESHOLD - 1, THRESHOLD - 1, false]
	])('%s', (_name, wallMs, perfMs, relocks) => {
		const t = setup();
		t.ways['resume'].hide();
		t.order.length = 0;
		t.away(wallMs, perfMs);
		t.ways['resume'].back();
		expect(t.order.includes('lock idle')).toBe(relocks);
		expect(t.store.refresh).toHaveBeenCalledTimes(1);
	});

	// pagehide and the visibility change both announce one departure; the time away runs from the first.
	it('counts the time away from the first hide, not from a later one', () => {
		const t = setup();
		t.ways['a persisted pageshow'].hide();
		t.away(10 * MINUTE);
		t.ways['becoming visible'].hide();
		t.away(6 * MINUTE);
		t.ways['resume'].back();
		expect(t.store.lock).toHaveBeenCalledExactlyOnceWith('idle');
	});

	it('counts a page that started hidden from the start', () => {
		const t = setup({ hiddenAtStart: true });
		t.away(16 * MINUTE);
		t.ways['becoming visible'].back();
		expect(t.store.lock).toHaveBeenCalledExactlyOnceWith('idle');
	});

	it('treats a way back with no hide as no time away', () => {
		const t = setup();
		t.away(60 * MINUTE);
		t.ways['resume'].back();
		expect(t.store.lock).not.toHaveBeenCalled();
		expect(t.store.refresh).toHaveBeenCalledTimes(1);
	});

	// pageshow, resume and visible often arrive together; the first one is the way back, the rest find the store shut.
	it('relocks once when all three ways back arrive for one absence', () => {
		const t = setup();
		t.ways['a persisted pageshow'].hide();
		t.ways['resume'].hide();
		t.away(16 * MINUTE);
		t.ways['a persisted pageshow'].back();
		t.ways['resume'].back();
		t.ways['becoming visible'].back();
		expect(t.store.lock).toHaveBeenCalledOnce();
	});

	describe('with the real idle timer', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		// Time on screen with no touch is time away from the person too: 14 quiet minutes and 5 hidden ones are past the
		// threshold, and the lock must come before the re-read.
		it('counts quiet time before the hide: 14 minutes quiet, then 5 hidden, locks before any re-read', () => {
			const t = setup({ realTimer: true });
			t.away(14 * MINUTE);
			t.ways['becoming visible'].hide();
			t.order.length = 0;
			t.away(5 * MINUTE);
			t.ways['becoming visible'].back();
			expect(t.order).toEqual(['lock idle', 'refresh']);
			t.off();
		});

		// The long absence already locked once; the overdue count must not lock again on the touch that comes next.
		it('the first touch after a long absence does not fire a second, stale idle lock', () => {
			const t = setup({ realTimer: true });
			t.ways['becoming visible'].hide();
			t.away(16 * MINUTE);
			t.ways['becoming visible'].back();
			t.win.dispatchEvent(new Event('pointerdown'));
			expect(t.store.lock).toHaveBeenCalledExactlyOnceWith('idle');
			t.off();
		});

		it('a touch before the hide starts the count again', () => {
			const t = setup({ realTimer: true });
			t.away(14 * MINUTE);
			t.win.dispatchEvent(new Event('pointerdown'));
			t.ways['becoming visible'].hide();
			t.order.length = 0;
			t.away(5 * MINUTE);
			t.ways['becoming visible'].back();
			expect(t.order).toEqual(['refresh']);
			t.off();
		});
	});

	// A frozen page can be resumed while still hidden. That is not the person coming back, so the hide time must
	// survive it for the way back that is.
	it('keeps the hide time through a resume that arrives while the page is still hidden', () => {
		const t = setup();
		t.ways['becoming visible'].hide();
		t.doc.dispatchEvent(new Event('freeze'));
		t.away(1 * MINUTE);
		t.doc.dispatchEvent(new Event('resume'));
		t.order.length = 0;
		t.away(60 * MINUTE);
		t.ways['becoming visible'].back();
		expect(t.order).toEqual(['lock idle', 'refresh', 'timer start']);
	});
});

describe('subscribeBus', () => {
	it('passes the signal to its handler', () => {
		let deliver: ((s: BusSignal) => void) | undefined;
		const bus: ProfileBus = {
			publish: () => {},
			subscribe: (h) => {
				deliver = h;
				return () => {};
			},
			close: () => {}
		};
		const onRelocked = vi.fn();
		subscribeBus(bus, { relocked: onRelocked });
		const signal: BusSignal = { type: 'relocked', reason: 'idle' };
		deliver?.(signal);
		expect(onRelocked).toHaveBeenCalledExactlyOnceWith(signal);
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

describe('reloadOnSignalWhenShown', () => {
	const ALL_TYPES: BusSignal['type'][] = [
		'profile-updated',
		'relocked',
		'timeline-updated',
		'calendar-updated',
		'skillbridge-finder-updated',
		'data-replaced'
	];

	function setup(opts: { hidden: boolean; locked?: boolean; type?: BusSignal['type'] }) {
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
		const doc = Object.assign(new EventTarget(), { hidden: opts.hidden });
		const state = { locked: opts.locked ?? false };
		const reload = vi.fn();
		const onLocked = vi.fn();
		const stop = reloadOnSignalWhenShown(
			bus,
			opts.type ?? 'data-replaced',
			doc,
			() => state.locked,
			onLocked,
			reload
		);
		return {
			reload,
			onLocked,
			stop,
			state,
			signal: (type: BusSignal['type'] = 'data-replaced') => handler?.({ type }),
			show: () => {
				doc.hidden = false;
				doc.dispatchEvent(new Event('visibilitychange'));
			}
		};
	}

	// Only a replaced-data signal means this tab's view is stale; every other signal has its own handler.
	it('ignores every other signal type', () => {
		const t = setup({ hidden: false });
		for (const type of ALL_TYPES.filter((x) => x !== 'data-replaced')) t.signal(type);
		expect(t.reload).not.toHaveBeenCalled();
		expect(t.onLocked).not.toHaveBeenCalled();
	});

	it('reloads at once when shown and unlocked', () => {
		const t = setup({ hidden: false });
		t.signal();
		expect(t.reload).toHaveBeenCalledTimes(1);
		expect(t.onLocked).not.toHaveBeenCalled();
	});

	// A reload runs the start-up again, which decrypts; a hidden tab must not hold that plaintext.
	it('holds the reload while hidden, then reloads once when shown', () => {
		const t = setup({ hidden: true });
		t.signal();
		t.signal();
		expect(t.reload).not.toHaveBeenCalled();
		t.show();
		expect(t.reload).toHaveBeenCalledTimes(1);
		t.show();
		expect(t.reload).toHaveBeenCalledTimes(1);
	});

	// A locked tab must not open itself: it only remembers to reload when the user unlocks.
	it('marks reload-on-unlock and does not reload when locked', () => {
		const t = setup({ hidden: false, locked: true });
		t.signal();
		expect(t.onLocked).toHaveBeenCalledTimes(1);
		expect(t.reload).not.toHaveBeenCalled();
	});

	// A tab that is both hidden and locked must record the pending reload at the signal, not only when it is
	// later shown: it may never be shown before the user unlocks.
	it('marks reload-on-unlock at the signal when the tab is hidden and locked', () => {
		const t = setup({ hidden: true, locked: true });
		t.signal();
		expect(t.onLocked).toHaveBeenCalledTimes(1);
		expect(t.reload).not.toHaveBeenCalled();
		t.show();
		expect(t.onLocked).toHaveBeenCalledTimes(1);
		expect(t.reload).not.toHaveBeenCalled();
	});

	// The type is a parameter, not a constant: a helper built for another type reacts to that one only.
	it('reacts to the type it was given and ignores data-replaced otherwise', () => {
		const t = setup({ hidden: false, type: 'relocked' });
		t.signal('data-replaced');
		expect(t.reload).not.toHaveBeenCalled();
		t.signal('relocked');
		expect(t.reload).toHaveBeenCalledTimes(1);
	});

	it('marks reload-on-unlock when the tab locked while it waited hidden', () => {
		const t = setup({ hidden: true });
		t.signal();
		t.state.locked = true;
		t.show();
		expect(t.onLocked).toHaveBeenCalledTimes(1);
		expect(t.reload).not.toHaveBeenCalled();
	});

	it('does nothing after teardown, whether the reload was waiting or not', () => {
		const idle = setup({ hidden: false });
		idle.stop();
		idle.signal();
		expect(idle.reload).not.toHaveBeenCalled();
		expect(idle.onLocked).not.toHaveBeenCalled();

		const waiting = setup({ hidden: true });
		waiting.signal();
		waiting.stop();
		waiting.show();
		expect(waiting.reload).not.toHaveBeenCalled();
		expect(waiting.onLocked).not.toHaveBeenCalled();
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
