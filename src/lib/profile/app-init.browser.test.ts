import { describe, it, expect, afterEach, vi } from 'vitest';
import { subscribeBusToStore } from './app-init';
import { createProfileBus, type ProfileBus } from '../broadcast/bus';

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
