import { describe, it, expect, vi, afterEach } from 'vitest';
import { whenControlled } from './when-controlled';

// A stand-in for navigator.serviceWorker: the one member the wait reads, and real events.
class FakeContainer extends EventTarget {
	controller: object | null = null;
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

	it('keeps waiting until the time runs out while no worker takes charge', async () => {
		vi.useFakeTimers();
		let settled = false;
		void whenControlled(10_000, asContainer(new FakeContainer())).then(() => (settled = true));
		vi.advanceTimersByTime(9_999);
		await Promise.resolve();
		expect(settled).toBe(false);
	});
});
