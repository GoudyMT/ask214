import { describe, it, expect, afterEach, vi } from 'vitest';
import { subscribeBusToStore, installProfileLifecycle } from './app-init';
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
	return { relockSync: vi.fn(), load: vi.fn().mockResolvedValue(null) };
}

afterEach(() => {
	for (const bus of buses) bus.close();
	buses.length = 0;
});

describe('subscribeBusToStore', () => {
	it('relays a relocked signal to store.relockSync', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const store = makeSpyStore();
		subscribeBusToStore(store, tabB);
		tabA.publish({ type: 'relocked' });
		await delay(100);
		expect(store.relockSync).toHaveBeenCalledTimes(1);
		expect(store.load).not.toHaveBeenCalled();
	});

	it('relays a profile-updated signal to store.load', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const store = makeSpyStore();
		subscribeBusToStore(store, tabB);
		tabA.publish({ type: 'profile-updated' });
		await delay(100);
		expect(store.load).toHaveBeenCalledTimes(1);
		expect(store.relockSync).not.toHaveBeenCalled();
	});

	it('stops relaying after the returned unsubscribe is called', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const store = makeSpyStore();
		const off = subscribeBusToStore(store, tabB);
		off();
		tabA.publish({ type: 'relocked' });
		await delay(100);
		expect(store.relockSync).not.toHaveBeenCalled();
	});
});

function makeLifecycleHarness() {
	const store = {
		relockSync: vi.fn(),
		load: vi.fn().mockResolvedValue(null),
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
	const install = () =>
		installProfileLifecycle(store, { win, doc, createIdleTimer, idleThresholdMs });
	return {
		store,
		timer,
		createIdleTimer,
		win,
		doc,
		idleThresholdMs,
		install,
		getOnIdle: () => onIdle
	};
}

describe('installProfileLifecycle', () => {
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

	it('re-reads on a persisted pageshow (BFCache restore)', () => {
		const h = makeLifecycleHarness();
		h.install();
		const e = new Event('pageshow');
		Object.defineProperty(e, 'persisted', { value: true });
		h.win.dispatchEvent(e);
		expect(h.store.load).toHaveBeenCalledTimes(1);
	});

	it('does not re-read on a non-persisted pageshow', () => {
		const h = makeLifecycleHarness();
		h.install();
		h.win.dispatchEvent(new Event('pageshow'));
		expect(h.store.load).not.toHaveBeenCalled();
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
});
