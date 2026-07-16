import { describe, it, expect, afterEach } from 'vitest';
import { openMtcDb, withStores, reqToPromise, STORES, DB_VERSION } from './schema';
import { openTestDb, deleteTestDb } from './_test-helpers';

// Real IndexedDB in the Chromium `client` Vitest project. Each test opens
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

// The v2 schema exactly as it shipped. Frozen here on purpose: openMtcDb only ever opens at the
// CURRENT version, so without a historical opener no test can watch onupgradeneeded do anything but
// create-from-scratch - and the "skip stores that already exist" guard is precisely what an existing
// user's data depends on.
const V2_STORES = ['profile', 'profile-hwm', 'keystore', 'timeline-state', 'timeline-state-hwm'];

/** Opens `name` at an arbitrary version without touching the schema - stands in for another tab. */
function openAtVersion(name: string, version: number): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(name, version);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('open-failed'));
		req.onblocked = () => reject(new Error('open-blocked'));
	});
}

function openV2Db(name: string): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(name, 2);
		req.onupgradeneeded = () => {
			for (const store of V2_STORES) req.result.createObjectStore(store, { keyPath: 'id' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('v2-open-failed'));
	});
}

describe('openMtcDb schema (v3)', () => {
	it('opens at the current DB_VERSION with exactly the registered stores', async () => {
		const db = await freshDb();
		expect(db.version).toBe(DB_VERSION);
		expect(Array.from(db.objectStoreNames).sort()).toEqual([
			'calendar-sync',
			'calendar-sync-hwm',
			'keystore',
			'profile',
			'profile-hwm',
			'timeline-state',
			'timeline-state-hwm'
		]);
	});

	it('does NOT create the deferred journal/meta stores', async () => {
		const db = await freshDb();
		expect(db.objectStoreNames.contains('journal')).toBe(false);
		expect(db.objectStoreNames.contains('meta')).toBe(false);
	});

	it('upgrades a real v2 database to v3, adding the calendar stores without touching prior data', async () => {
		const name = 'mtc-test-' + crypto.randomUUID();

		// A returning user's database: v2, with encrypted records already written.
		const v2 = await openV2Db(name);
		expect(v2.version).toBe(2);
		expect(v2.objectStoreNames.contains('calendar-sync')).toBe(false);

		const profileCipher = new Uint8Array([1, 2, 3, 250, 251, 252]);
		const timelineCipher = new Uint8Array([9, 8, 7, 0, 255]);
		await withStores(v2, ['profile', 'timeline-state'], 'readwrite', (tx) => {
			tx.objectStore('profile').put({ id: 0, rec: profileCipher });
			tx.objectStore('timeline-state').put({ id: 0, rec: timelineCipher });
		});
		// The old connection must be released or the upgrade blocks instead of running.
		v2.close();

		// The upgrade every existing user runs on first load of the new bundle.
		const v3 = await openMtcDb(name);
		opened.push(v3);
		expect(v3.version).toBe(DB_VERSION);
		expect(v3.objectStoreNames.contains('calendar-sync')).toBe(true);
		expect(v3.objectStoreNames.contains('calendar-sync-hwm')).toBe(true);

		// The load-bearing half: the upgrade loop must SKIP the stores that already exist. Recreating
		// one would empty it, and the ciphertext is unrecoverable - there is no server copy.
		const gotProfile = await withStores(v3, 'profile', 'readonly', (tx) =>
			reqToPromise<{ id: number; rec: Uint8Array } | undefined>(tx.objectStore('profile').get(0))
		);
		const gotTimeline = await withStores(v3, 'timeline-state', 'readonly', (tx) =>
			reqToPromise<{ id: number; rec: Uint8Array } | undefined>(
				tx.objectStore('timeline-state').get(0)
			)
		);
		expect(gotProfile?.rec).toEqual(profileCipher);
		expect(gotTimeline?.rec).toEqual(timelineCipher);
	});

	it('releases the connection when another tab requests a newer version', async () => {
		const name = 'mtc-test-' + crypto.randomUUID();
		const held = await openMtcDb(name);
		opened.push(held);

		// +layout holds this connection for the tab's whole lifetime. When a tab on a newer bundle
		// requests an upgrade, this one must step aside, or that tab blocks forever - and its app
		// sits in a permanent, silent loading state with no profile and no error.
		const upgrading = await openAtVersion(name, DB_VERSION + 1);
		expect(upgrading.version).toBe(DB_VERSION + 1);
		upgrading.close();
	});

	it('cannot rescue a tab already running the pre-v3 bundle', async () => {
		// The handler has to exist in the tab doing the BLOCKING, and the deployed v2 bundle opens
		// without one. Nothing shipped now can change that, so the 2 -> 3 upgrade still blocks while an
		// old tab is open; the handler above protects 3 -> 4 onward. Telling the user to close the
		// other tab is the only mitigation available for this one upgrade.
		const name = 'mtc-test-' + crypto.randomUUID();
		const oldTab = await openV2Db(name);
		await expect(openMtcDb(name)).rejects.toThrow('idb-open-blocked');
		oldTab.close();
	});

	it('each store uses keyPath "id" (single self-row pattern)', async () => {
		const db = await freshDb();
		for (const store of STORES) {
			const tx = db.transaction(store, 'readonly');
			expect(tx.objectStore(store).keyPath).toBe('id');
		}
	});

	it('STORES enumerates exactly the registered stores', () => {
		expect([...STORES].sort()).toEqual([
			'calendar-sync',
			'calendar-sync-hwm',
			'keystore',
			'profile',
			'profile-hwm',
			'timeline-state',
			'timeline-state-hwm'
		]);
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
