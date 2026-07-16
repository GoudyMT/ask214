import { describe, it, expect, afterEach, vi } from 'vitest';
import { subscribeBus, installLifecycle, createRelockEcho, type Relockable } from './app-init';
import { createProfileBus, type ProfileBus } from '../broadcast/bus';
import type { IdleTimerOptions, IdleTimer } from './idle-timer';

const buses: ProfileBus[] = [];

function makeBus(name: string): ProfileBus {
	const bus = createProfileBus(name);
	buses.push(bus);
	return bus;
}

function uniqueName(): string {
	return 'mtc-test-' + crypto.randomUUID();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSpyStore() {
	return {
		relockSync: vi.fn<Relockable['relockSync']>(),
		refresh: vi.fn().mockResolvedValue(null)
	};
}

afterEach(() => {
	for (const bus of buses) bus.close();
	buses.length = 0;
});

describe('createRelockEcho over a real BroadcastChannel', () => {
	/**
	 * Wires a tab the way +layout does: three stores that each signal `relocked`, and a bus handler
	 * that relocks all of them when a peer signals. Returns what this tab HEARS from its peer.
	 */
	function wireTab(name: string): { bus: ProfileBus; heard: string[] } {
		const bus = makeBus(name);
		const echo = createRelockEcho(bus);
		const heard: string[] = [];
		subscribeBus(bus, {
			relocked: () => {
				heard.push('relocked');
				// The real handler: relock every store. Each store signals through the echo seam.
				echo.answer(() => {
					for (let i = 0; i < 3; i++) echo.publish({ type: 'relocked' });
				});
			}
		});
		return { bus, heard };
	}

	it('a pagehide relock does not ping-pong between two tabs', async () => {
		const name = uniqueName();
		const a = wireTab(name);
		const b = wireTab(name);

		// Tab A backgrounds: its three stores relock and signal. Without the seam, B answers with 3,
		// A answers those with 9, B with 27 - the channel saturates and both tabs wedge.
		const echoA = createRelockEcho(a.bus);
		for (let i = 0; i < 3; i++) echoA.publish({ type: 'relocked' });
		await delay(200);

		// B hears A's three and relocks. A hears NOTHING back: the storm never starts.
		expect(b.heard).toEqual(['relocked', 'relocked', 'relocked']);
		expect(a.heard).toEqual([]);
	});
});

describe('subscribeBus', () => {
	function profileHandlers(store: Pick<Relockable, 'relockSync' | 'refresh'>) {
		return {
			relocked: () => store.relockSync('peer'),
			'profile-updated': () => void store.refresh()
		};
	}

	it('routes a relocked signal to its handler', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const store = makeSpyStore();
		subscribeBus(tabB, profileHandlers(store));
		tabA.publish({ type: 'relocked' });
		await delay(100);
		expect(store.relockSync).toHaveBeenCalledTimes(1);
		expect(store.refresh).not.toHaveBeenCalled();
	});

	it('routes a profile-updated signal to its handler', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const store = makeSpyStore();
		subscribeBus(tabB, profileHandlers(store));
		tabA.publish({ type: 'profile-updated' });
		await delay(100);
		expect(store.refresh).toHaveBeenCalledTimes(1);
		expect(store.relockSync).not.toHaveBeenCalled();
	});

	it('routes a timeline-updated signal to its handler', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const onTimeline = vi.fn();
		subscribeBus(tabB, { 'timeline-updated': onTimeline });
		tabA.publish({ type: 'timeline-updated' });
		await delay(100);
		expect(onTimeline).toHaveBeenCalledTimes(1);
	});

	it('stops routing after the returned unsubscribe is called', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const store = makeSpyStore();
		const off = subscribeBus(tabB, profileHandlers(store));
		off();
		tabA.publish({ type: 'relocked' });
		await delay(100);
		expect(store.relockSync).not.toHaveBeenCalled();
	});
});

function makeLifecycleHarness() {
	const store = {
		relockSync: vi.fn(),
		refresh: vi.fn().mockResolvedValue(null),
		lock: vi.fn().mockResolvedValue(undefined)
	};
	const timer: IdleTimer = { start: vi.fn(), stop: vi.fn(), recordActivity: vi.fn() };
	let onIdle: (() => void) | undefined;
	const createIdleTimer = vi.fn((opts: IdleTimerOptions): IdleTimer => {
		onIdle = opts.onIdle;
		return timer;
	});
	const win = new EventTarget();
	const doc = new EventTarget();
	const idleThresholdMs = 900_000;
	let hidden = false;
	const isHidden = () => hidden;
	const install = () =>
		installLifecycle([store], { win, doc, isHidden, createIdleTimer, idleThresholdMs });
	return {
		store,
		timer,
		createIdleTimer,
		win,
		doc,
		idleThresholdMs,
		install,
		getOnIdle: () => onIdle,
		setHidden: (v: boolean) => {
			hidden = v;
		}
	};
}

describe('installLifecycle', () => {
	it('relocks on pagehide', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.win.dispatchEvent(new Event('pagehide'));
		expect(h.store.relockSync).toHaveBeenCalledTimes(1);
	});

	it('relocks on freeze', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.doc.dispatchEvent(new Event('freeze'));
		expect(h.store.relockSync).toHaveBeenCalledTimes(1);
	});

	// The page going away is hygiene, not a decision - and saying so is the whole difference between
	// a restore that works and one that never fires. Asserting only that relockSync was CALLED is
	// what let the restore die unnoticed.
	it('calls the page-lifecycle relock hygiene, so the restore may undo it', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.win.dispatchEvent(new Event('pagehide'));
		expect(h.store.relockSync).toHaveBeenCalledWith('hygiene');
	});

	it('calls the idle relock idle, so the restore may not undo it', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.getOnIdle()?.();
		expect(h.store.lock).toHaveBeenCalledWith('idle');
	});

	it('re-reads on a persisted pageshow (BFCache restore)', () => {
		const h = makeLifecycleHarness();
		h.install();
		const e = new Event('pageshow');
		Object.defineProperty(e, 'persisted', { value: true });
		h.win.dispatchEvent(e);
		expect(h.store.refresh).toHaveBeenCalledTimes(1);
	});

	it('does not re-read on a non-persisted pageshow', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.win.dispatchEvent(new Event('pageshow'));
		expect(h.store.refresh).not.toHaveBeenCalled();
	});

	// A browser freezing a quiet background tab dispatches freeze and later resume, with no
	// navigation and therefore no pagehide or pageshow. Relocking on freeze while only pageshow
	// restores means that tab zeroizes its plaintext and never reads it back - a blank page the user
	// can only fix by reloading. resume is also not a PageTransitionEvent, so it carries no
	// `persisted` flag to gate on: being resumed IS the signal.
	it('re-reads on resume, the counterpart to the freeze that relocked it', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.doc.dispatchEvent(new Event('freeze'));
		h.doc.dispatchEvent(new Event('resume'));
		expect(h.store.refresh).toHaveBeenCalledTimes(1);
	});

	it('stops re-reading on resume after teardown', () => {
		const h = makeLifecycleHarness();
		const off = h.install();
		off();
		h.doc.dispatchEvent(new Event('resume'));
		expect(h.store.refresh).not.toHaveBeenCalled();
	});

	// The page being hidden is the only relock signal every browser agrees on. freeze is Chromium
	// only, and an app-switch on iOS may deliver no pagehide at all - so without this, the plaintext
	// of a backgrounded tab stays in the heap, which is the one thing it must not do.
	it('relocks as hygiene when the page becomes hidden', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.setHidden(true);
		h.doc.dispatchEvent(new Event('visibilitychange'));
		expect(h.store.relockSync).toHaveBeenCalledWith('hygiene');
	});

	// visibilitychange carries no persisted flag and fires both ways, so becoming visible IS the
	// restore signal. Without it, a tab switch away and back would relock and never re-read.
	it('re-reads when the page becomes visible again', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.setHidden(true);
		h.doc.dispatchEvent(new Event('visibilitychange'));
		h.setHidden(false);
		h.doc.dispatchEvent(new Event('visibilitychange'));
		expect(h.store.refresh).toHaveBeenCalledTimes(1);
	});

	it('stops relocking on visibilitychange after teardown', () => {
		const h = makeLifecycleHarness();
		const off = h.install();
		off();
		h.setHidden(true);
		h.doc.dispatchEvent(new Event('visibilitychange'));
		expect(h.store.relockSync).not.toHaveBeenCalled();
	});

	it('starts an idle timer at the given threshold whose onIdle locks the store', () => {
		const h = makeLifecycleHarness();
		h.install();
		expect(h.createIdleTimer).toHaveBeenCalledTimes(1);
		expect(h.createIdleTimer.mock.calls[0]?.[0].thresholdMs).toBe(h.idleThresholdMs);
		expect(h.timer.start).toHaveBeenCalledTimes(1);
		h.getOnIdle()?.();
		expect(h.store.lock).toHaveBeenCalledTimes(1);
	});

	it('records activity on a user-input event', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.win.dispatchEvent(new Event('pointerdown'));
		expect(h.timer.recordActivity).toHaveBeenCalled();
	});

	it('stops the timer and removes listeners on teardown', () => {
		const h = makeLifecycleHarness();
		const off = h.install();
		off();
		expect(h.timer.stop).toHaveBeenCalledTimes(1);
		h.win.dispatchEvent(new Event('pagehide'));
		expect(h.store.relockSync).not.toHaveBeenCalled();
	});

	it('relocks every store in the list on pagehide', () => {
		const a = {
			relockSync: vi.fn(),
			refresh: vi.fn().mockResolvedValue(null),
			lock: vi.fn().mockResolvedValue(undefined)
		};
		const b = { relockSync: vi.fn(), refresh: vi.fn().mockResolvedValue(null) };
		const win = new EventTarget();
		const timer: IdleTimer = { start: vi.fn(), stop: vi.fn(), recordActivity: vi.fn() };
		installLifecycle([a, b], {
			win,
			doc: new EventTarget(),
			isHidden: () => false,
			createIdleTimer: () => timer,
			idleThresholdMs: 900_000
		});
		win.dispatchEvent(new Event('pagehide'));
		expect(a.relockSync).toHaveBeenCalledTimes(1);
		expect(b.relockSync).toHaveBeenCalledTimes(1);
	});

	it('on idle, locks stores that expose lock() and relockSyncs those that do not', () => {
		const a = {
			relockSync: vi.fn(),
			refresh: vi.fn().mockResolvedValue(null),
			lock: vi.fn().mockResolvedValue(undefined)
		};
		const b = { relockSync: vi.fn(), refresh: vi.fn().mockResolvedValue(null) };
		let onIdle: (() => void) | undefined;
		const timer: IdleTimer = { start: vi.fn(), stop: vi.fn(), recordActivity: vi.fn() };
		installLifecycle([a, b], {
			win: new EventTarget(),
			doc: new EventTarget(),
			isHidden: () => false,
			createIdleTimer: (opts: IdleTimerOptions) => {
				onIdle = opts.onIdle;
				return timer;
			},
			idleThresholdMs: 900_000
		});
		onIdle?.();
		expect(a.lock).toHaveBeenCalledTimes(1);
		expect(a.relockSync).not.toHaveBeenCalled();
		expect(b.relockSync).toHaveBeenCalledTimes(1);
	});
});
