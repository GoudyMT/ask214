import { describe, it, expect, vi } from 'vitest';
import { initProfileApp } from './app-init';
import { KeystoreAlreadyExistsError } from '../keystore/bootstrap';

const fakeDb = {} as IDBDatabase;
const makeStore = () => ({ load: vi.fn().mockResolvedValue(null) });

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
