import { describe, it, expect, afterEach } from 'vitest';
import { withStores, reqToPromise, STORES, DB_VERSION } from './schema';
import { openTestDb, deleteTestDb } from './_test-helpers';

// Real IndexedDB in the Chromium `client` Vitest project (T6-C). Each test opens
// a uniquely-named DB; afterEach deletes them so DBs don't leak across the suite.
let opened: IDBDatabase[] = [];

async function freshDb(): Promise<IDBDatabase> {
	const db = await openTestDb();
	opened.push(db);
	return db;
}

afterEach(async () => {
	for (const db of opened) await deleteTestDb(db);
	opened = [];
});

describe('openMtcDb schema v1', () => {
	it('opens at version 1 with exactly the 3 v1.0 stores', async () => {
		const db = await freshDb();
		expect(db.version).toBe(DB_VERSION);
		expect(Array.from(db.objectStoreNames).sort()).toEqual(['keystore', 'profile', 'profile-hwm']);
	});

	it('does NOT create the deferred journal/meta stores', async () => {
		const db = await freshDb();
		expect(db.objectStoreNames.contains('journal')).toBe(false);
		expect(db.objectStoreNames.contains('meta')).toBe(false);
	});

	it('each store uses keyPath "id" (single self-row pattern)', async () => {
		const db = await freshDb();
		for (const store of STORES) {
			const tx = db.transaction(store, 'readonly');
			expect(tx.objectStore(store).keyPath).toBe('id');
		}
	});

	it('STORES enumerates exactly the registered stores', () => {
		expect([...STORES].sort()).toEqual(['keystore', 'profile', 'profile-hwm']);
	});
});

describe('withStores transaction helper', () => {
	it('commits a single-store put and reads it back', async () => {
		const db = await freshDb();
		await withStores(db, 'keystore', 'readwrite', (tx) => {
			tx.objectStore('keystore').put({ id: 0, marker: 'hello' });
		});
		const got = await withStores(db, 'keystore', 'readonly', (tx) =>
			reqToPromise(tx.objectStore('keystore').get(0))
		);
		expect(got).toEqual({ id: 0, marker: 'hello' });
	});

	it('writes across two stores atomically in one transaction', async () => {
		const db = await freshDb();
		await withStores(db, ['keystore', 'profile-hwm'], 'readwrite', (tx) => {
			tx.objectStore('keystore').put({ id: 0, a: 1 });
			tx.objectStore('profile-hwm').put({ id: 0, b: 2 });
		});
		const ks = await withStores(db, 'keystore', 'readonly', (tx) =>
			reqToPromise(tx.objectStore('keystore').get(0))
		);
		const hwm = await withStores(db, 'profile-hwm', 'readonly', (tx) =>
			reqToPromise(tx.objectStore('profile-hwm').get(0))
		);
		expect(ks).toEqual({ id: 0, a: 1 });
		expect(hwm).toEqual({ id: 0, b: 2 });
	});

	it('rolls back and rejects when fn throws after a queued write', async () => {
		const db = await freshDb();
		await expect(
			withStores(db, 'keystore', 'readwrite', (tx) => {
				tx.objectStore('keystore').put({ id: 0, a: 1 });
				throw new Error('boom');
			})
		).rejects.toThrow('boom');

		const got = await withStores(db, 'keystore', 'readonly', (tx) =>
			reqToPromise(tx.objectStore('keystore').get(0))
		);
		expect(got).toBeUndefined();
	});
});
