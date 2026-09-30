import { describe, it, expect, vi, afterEach } from 'vitest';
import { whenControlled } from './when-controlled';

// A stand-in for navigator.serviceWorker: the members the wait reads, and real events.
class FakeContainer extends EventTarget {
	controller: object | null = null;
	registration: object | undefined = undefined;
	getRegistration = async () => this.registration;
}
const asContainer = (fake: FakeContainer) => fake as unknown as ServiceWorkerContainer;

describe('whenControlled', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('is false at once where the browser has no service workers', async () => {
		expect(await whenControlled(10_000, undefined)).toBe(false);
	});

	it('is true at once when a worker already controls the page, and listens for nothing', async () => {
		const fake = new FakeContainer();
		fake.controller = {};
		const listen = vi.spyOn(fake, 'addEventListener');
		// Read after one tick rather than awaited, so a wait that never ends fails here instead of hanging.
		let controlled: boolean | undefined;
		void whenControlled(10_000, asContainer(fake)).then((result) => (controlled = result));
		await Promise.resolve();
		expect(controlled).toBe(true);
		expect(listen).not.toHaveBeenCalled();
	});

	it('is true when a worker takes charge within the time, and stops listening', async () => {
		vi.useFakeTimers();
		const fake = new FakeContainer();
		const stop = vi.spyOn(fake, 'removeEventListener');
		const waiting = whenControlled(10_000, asContainer(fake));
		vi.advanceTimersByTime(3_000);
		fake.dispatchEvent(new Event('controllerchange'));
		expect(await waiting).toBe(true);
		expect(stop).toHaveBeenCalledWith('controllerchange', expect.any(Function));
	});

	it('is false when the time runs out first, and stops listening', async () => {
		vi.useFakeTimers();
		const fake = new FakeContainer();
		const stop = vi.spyOn(fake, 'removeEventListener');
		const waiting = whenControlled(10_000, asContainer(fake));
		vi.advanceTimersByTime(10_000);
		expect(await waiting).toBe(false);
		expect(stop).toHaveBeenCalledWith('controllerchange', expect.any(Function));
	});

	// A worker that has finished activating and does not control the page never will (a hard reload bypasses it):
	// claiming pages happens only while it activates.
	it('is false at once when an active worker will never control the page', async () => {
		const fake = new FakeContainer();
		fake.registration = { active: { state: 'activated' }, installing: null, waiting: null };
		let controlled: boolean | undefined;
		void whenControlled(10_000, asContainer(fake)).then((result) => (controlled = result));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(controlled).toBe(false);
	});

	it('keeps waiting while a worker is still installing or activating', async () => {
		for (const registration of [
			{ active: null, installing: {}, waiting: null },
			{ active: { state: 'activating' }, installing: null, waiting: null },
			// An update behind the active worker may still activate and claim this page.
			{ active: { state: 'activated' }, installing: {}, waiting: null },
			{ active: { state: 'activated' }, installing: null, waiting: {} }
		]) {
			const fake = new FakeContainer();
			fake.registration = registration;
			let controlled: boolean | undefined;
			void whenControlled(10_000, asContainer(fake)).then((result) => (controlled = result));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(controlled, JSON.stringify(registration)).toBeUndefined();
			fake.dispatchEvent(new Event('controllerchange'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(controlled, JSON.stringify(registration)).toBe(true);
		}
	});

	it('keeps waiting until the time runs out while no worker takes charge', async () => {
		vi.useFakeTimers();
		let settled = false;
		void whenControlled(10_000, asContainer(new FakeContainer())).then(() => (settled = true));
		vi.advanceTimersByTime(9_999);
		await Promise.resolve();
		expect(settled).toBe(false);
	});
});

describe('waitForControl', () => {
	// The memo lives at module scope, so each case loads the module afresh and stubs the browser's container.
	async function loadModule(container: FakeContainer) {
		vi.resetModules();
		vi.stubGlobal('navigator', { serviceWorker: asContainer(container) });
		return import('./when-controlled');
	}

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('hands every caller the one wait, so a visit waits at most once', async () => {
		const fake = new FakeContainer();
		const { waitForControl } = await loadModule(fake);
		const first = waitForControl();
		expect(waitForControl()).toBe(first);
		fake.controller = {};
		expect(waitForControl()).toBe(first);
	});

	// A worker that did not come within the time is not waited for again: each later download goes ahead at once.
	it('hands back the same settled answer after a wait that timed out, not a new wait', async () => {
		vi.useFakeTimers();
		const fake = new FakeContainer();
		const { waitForControl, CONTROL_WAIT_MS } = await loadModule(fake);
		const first = waitForControl();
		vi.advanceTimersByTime(CONTROL_WAIT_MS);
		expect(await first).toBe(false);
		const listen = vi.spyOn(fake, 'addEventListener');
		expect(waitForControl()).toBe(first);
		expect(listen).not.toHaveBeenCalled();
	});

	it('gives up on a worker that does not come once the wait time has passed', async () => {
		vi.useFakeTimers();
		const { waitForControl, CONTROL_WAIT_MS } = await loadModule(new FakeContainer());
		let settled: boolean | undefined;
		void waitForControl().then((controlled) => (settled = controlled));
		vi.advanceTimersByTime(CONTROL_WAIT_MS - 1);
		await Promise.resolve();
		expect(settled).toBeUndefined();
		vi.advanceTimersByTime(1);
		await Promise.resolve();
		expect(settled).toBe(false);
	});
});
