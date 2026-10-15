import { describe, it, expect, afterEach } from 'vitest';
import { createProfileBus, type BusSignal, type ProfileBus } from './bus';

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

afterEach(() => {
	for (const bus of buses) bus.close();
	buses.length = 0;
});

describe('createProfileBus', () => {
	it('delivers a published signal to another bus on the same channel', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const received = new Promise<BusSignal | null>((resolve) => {
			tabB.subscribe((s) => resolve(s));
			setTimeout(() => resolve(null), 1000);
		});
		tabA.publish({ type: 'profile-updated' });
		expect(await received).toEqual({ type: 'profile-updated' });
	});

	it('delivers a timeline-updated signal to another bus on the same channel', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const received = new Promise<BusSignal | null>((resolve) => {
			tabB.subscribe((s) => resolve(s));
			setTimeout(() => resolve(null), 1000);
		});
		tabA.publish({ type: 'timeline-updated' });
		expect(await received).toEqual({ type: 'timeline-updated' });
	});

	it('does not deliver a published signal back to the publishing bus', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		let selfReceived = false;
		tabA.subscribe(() => {
			selfReceived = true;
		});
		tabA.publish({ type: 'profile-updated' });
		await delay(100);
		expect(selfReceived).toBe(false);
	});

	it('stops delivery after unsubscribe', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		let count = 0;
		const off = tabB.subscribe(() => {
			count += 1;
		});
		off();
		tabA.publish({ type: 'profile-updated' });
		await delay(100);
		expect(count).toBe(0);
	});

	it('ignores messages that are not recognized signals', async () => {
		const name = uniqueName();
		const tabB = makeBus(name);
		let received = 0;
		tabB.subscribe(() => {
			received += 1;
		});
		// A same-origin script could post arbitrary junk to the same channel name.
		const raw = new BroadcastChannel(name);
		raw.postMessage({ type: 'bogus' });
		raw.postMessage('not even an object');
		await delay(100);
		raw.close();
		expect(received).toBe(0);
	});

	it('data-replaced is a bus signal', async () => {
		const name = uniqueName();
		const tabA = makeBus(name);
		const tabB = makeBus(name);
		const received = new Promise<BusSignal | null>((resolve) => {
			tabB.subscribe((s) => resolve(s));
			setTimeout(() => resolve(null), 1000);
		});
		tabA.publish({ type: 'data-replaced' });
		expect(await received).toEqual({ type: 'data-replaced' });
	});

	it('toBusSignal keeps reason idle and user and drops any other value', async () => {
		const name = uniqueName();
		const tabB = makeBus(name);
		const seen: BusSignal[] = [];
		tabB.subscribe((s) => seen.push(s));
		// A same-origin script can post any shape: only the checked fields may reach a handler.
		const raw = new BroadcastChannel(name);
		raw.postMessage({ type: 'relocked', reason: 'idle' });
		raw.postMessage({ type: 'relocked', reason: 'user' });
		raw.postMessage({ type: 'relocked', reason: 'peer' });
		raw.postMessage({ type: 'relocked', reason: 42 });
		raw.postMessage({ type: 'relocked', evil: 1 });
		raw.postMessage({ type: 'relocked', reason: 'user', evil: 1 });
		await delay(200);
		raw.close();
		expect(seen).toEqual([
			{ type: 'relocked', reason: 'idle' },
			{ type: 'relocked', reason: 'user' },
			{ type: 'relocked' },
			{ type: 'relocked' },
			{ type: 'relocked' },
			{ type: 'relocked', reason: 'user' }
		]);
		for (const s of seen) expect('evil' in s).toBe(false);
		expect('reason' in (seen[2] ?? {})).toBe(false);
	});
});
