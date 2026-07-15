import { describe, it, expect, vi } from 'vitest';
import { initProfileApp, provisionStore, createRelockEcho } from './app-init';
import { KeystoreAlreadyExistsError } from '../keystore/bootstrap';
import type { BusSignal, ProfileBus } from '../broadcast/bus';

const fakeDb = {} as IDBDatabase;
const makeStore = () => ({ load: vi.fn().mockResolvedValue(null) });

function recordingBus(): { bus: ProfileBus; sent: BusSignal[] } {
	const sent: BusSignal[] = [];
	return {
		sent,
		bus: { publish: (s) => sent.push(s), subscribe: () => () => {}, close: () => {} }
	};
}

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
});
