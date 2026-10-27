import { describe, it, expect, afterEach, vi } from 'vitest';
import { openMtcDb, withStores, reqToPromise, STORES, DB_VERSION, type StoreName } from './schema';
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

// The v6 schema exactly as it shipped: the eight stores before the SkillBridge finder's. Frozen for the same reason as v2.
const V6_STORES: StoreName[] = [
	'byok',
	'calendar-sync',
	'calendar-sync-hwm',
	'keystore',
	'profile',
	'profile-hwm',
	'timeline-state',
	'timeline-state-hwm'
];

function openV6Db(name: string): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(name, 6);
		req.onupgradeneeded = () => {
			for (const store of V6_STORES) req.result.createObjectStore(store, { keyPath: 'id' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('v6-open-failed'));
	});
}

// The v7 schema exactly as it shipped: the eleven stores before the app lock's. Frozen for the same reason as v2.
const V7_STORES: StoreName[] = [
	...V6_STORES,
	'skillbridge-finder',
	'skillbridge-finder-hwm',
	'skillbridge-finder-pack'
];

function openV7Db(name: string): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(name, 7);
		req.onupgradeneeded = () => {
			for (const store of V7_STORES) req.result.createObjectStore(store, { keyPath: 'id' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('v7-open-failed'));
	});
}

describe('openMtcDb schema (v8)', () => {
	it('opens at the current DB_VERSION with exactly the registered stores', async () => {
		const db = await freshDb();
		expect(db.version).toBe(DB_VERSION);
		expect(db.version).toBe(8);
		expect(Array.from(db.objectStoreNames).sort()).toEqual([
			'app-lock',
			'byok',
			'calendar-sync',
			'calendar-sync-hwm',
			'keystore',
			'profile',
			'profile-hwm',
			'skillbridge-finder',
			'skillbridge-finder-hwm',
			'skillbridge-finder-pack',
			'timeline-state',
			'timeline-state-hwm'
		]);
	});

	// The upgrade every returning user runs: the finder's stores arrive and every row already on the device stays.
	it('upgrades a v6 database with a row in every old store, keeping each row', async () => {
		const name = 'mtc-test-' + crypto.randomUUID();
		const v6 = await openV6Db(name);
		expect(v6.version).toBe(6);
		expect(v6.objectStoreNames.contains('skillbridge-finder')).toBe(false);
		await withStores(v6, V6_STORES, 'readwrite', (tx) => {
			for (const store of V6_STORES) tx.objectStore(store).put({ id: 0, marker: `row-${store}` });
		});
		v6.close();

		const upgraded = await openMtcDb(name);
		opened.push(upgraded);
		expect(upgraded.version).toBe(8);
		for (const store of [
			'skillbridge-finder',
			'skillbridge-finder-hwm',
			'skillbridge-finder-pack'
		]) {
			expect(upgraded.objectStoreNames.contains(store), store).toBe(true);
		}
		for (const store of V6_STORES) {
			const row = await withStores(upgraded, store, 'readonly', (tx) =>
				reqToPromise<unknown>(tx.objectStore(store).get(0))
			);
			expect(row, store).toEqual({ id: 0, marker: `row-${store}` });
		}
	});

	// The upgrade every returning user runs for the app lock: its plain store arrives, every saved row stays byte for byte.
	it('upgrades a v7 database with a row in every old store, keeping each row and adding app-lock', async () => {
		const name = 'mtc-test-' + crypto.randomUUID();
		const v7 = await openV7Db(name);
		expect(v7.version).toBe(7);
		expect(v7.objectStoreNames.contains('app-lock')).toBe(false);
		const cipher = new Uint8Array([1, 2, 3, 250, 251, 252]);
		await withStores(v7, V7_STORES, 'readwrite', (tx) => {
			for (const store of V7_STORES)
				tx.objectStore(store).put({ id: 0, marker: `row-${store}`, cipher });
		});
		v7.close();

		const upgraded = await openMtcDb(name);
		opened.push(upgraded);
		expect(upgraded.version).toBe(8);
		expect(upgraded.objectStoreNames.contains('app-lock')).toBe(true);
		for (const store of V7_STORES) {
			const row = await withStores(upgraded, store, 'readonly', (tx) =>
				reqToPromise<unknown>(tx.objectStore(store).get(0))
			);
			expect(row, store).toEqual({ id: 0, marker: `row-${store}`, cipher });
		}
		const lockRows = await withStores(upgraded, 'app-lock', 'readonly', (tx) =>
			reqToPromise<unknown[]>(tx.objectStore('app-lock').getAll())
		);
		expect(lockRows).toEqual([]);
	});

	// The app asks this release's waiting worker to take over only after a raise: the older release's pages, which its
	// worker serves offline, cannot open the raised database. A new database or one already raised is no such event.
	it('says when it raised a database an older release made, and never otherwise', async () => {
		const name = 'mtc-test-' + crypto.randomUUID();
		(await openV6Db(name)).close();
		const raised = vi.fn();
		const upgraded = await openMtcDb(name, undefined, undefined, raised);
		expect(raised).toHaveBeenCalledOnce();
		upgraded.close();

		const again = vi.fn();
		opened.push(await openMtcDb(name, undefined, undefined, again));
		const created = vi.fn();
		opened.push(await openMtcDb('mtc-test-' + crypto.randomUUID(), undefined, undefined, created));
		expect(again).not.toHaveBeenCalled();
		expect(created).not.toHaveBeenCalled();
	});

	it('does NOT create the deferred journal/meta stores', async () => {
		const db = await freshDb();
		expect(db.objectStoreNames.contains('journal')).toBe(false);
		expect(db.objectStoreNames.contains('meta')).toBe(false);
	});

	it('upgrades a real v2 database to the current version, adding the new stores without touching prior data', async () => {
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
		const upgraded = await openMtcDb(name);
		opened.push(upgraded);
		expect(upgraded.version).toBe(DB_VERSION);
		expect(upgraded.objectStoreNames.contains('calendar-sync')).toBe(true);
		expect(upgraded.objectStoreNames.contains('calendar-sync-hwm')).toBe(true);
		expect(upgraded.objectStoreNames.contains('byok')).toBe(true);

		// The load-bearing half: the upgrade loop must SKIP the stores that already exist. Recreating
		// one would empty it, and the ciphertext is unrecoverable - there is no server copy.
		const gotProfile = await withStores(upgraded, 'profile', 'readonly', (tx) =>
			reqToPromise<{ id: number; rec: Uint8Array } | undefined>(tx.objectStore('profile').get(0))
		);
		const gotTimeline = await withStores(upgraded, 'timeline-state', 'readonly', (tx) =>
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

	it('invokes onVersionChange when a newer bundle upgrades, then steps aside', async () => {
		const name = 'mtc-test-' + crypto.randomUUID();
		let notified = 0;
		const held = await openMtcDb(name, () => {
			notified++;
		});
		opened.push(held);

		// The tab holding the old connection must be told a newer bundle took over - that is what lets
		// the layout show a reload prompt instead of leaving the tab in a silent, data-less state - AND
		// it must still step aside so the upgrade is not blocked.
		const upgrading = await openAtVersion(name, DB_VERSION + 1);
		expect(upgrading.version).toBe(DB_VERSION + 1);
		expect(notified).toBe(1);
		upgrading.close();
	});

	it('keeps waiting on a tab already running the pre-v3 bundle, and opens once it closes', async () => {
		// The handler has to exist in the tab doing the BLOCKING, and the deployed v2 bundle opens
		// without one. Nothing shipped now can change that, so the 2 -> 3 upgrade still blocks while an
		// old tab is open; the handler above protects 3 -> 4 onward. The open reports the block and
		// stays queued: closing the other tab is the only mitigation, and the same request then
		// finishes the upgrade by itself, with no reload.
		const name = 'mtc-test-' + crypto.randomUUID();
		const oldTab = await openV2Db(name);
		const blocked = vi.fn();
		const pending = openMtcDb(name, undefined, blocked);
		await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
		oldTab.close();
		const db = await pending;
		opened.push(db);
		expect(db.version).toBe(DB_VERSION);
		expect(blocked).toHaveBeenCalledOnce();
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
			'app-lock',
			'byok',
			'calendar-sync',
			'calendar-sync-hwm',
			'keystore',
			'profile',
			'profile-hwm',
			'skillbridge-finder',
			'skillbridge-finder-hwm',
			'skillbridge-finder-pack',
			'timeline-state',
			'timeline-state-hwm'
		]);
	});

	it('version 5 retires a tab still holding version 4 (it would save the profile without the leaving dates)', async () => {
		const name = `mtc-v5-${crypto.randomUUID()}`;
		const old = await openAtVersion(name, 4);
		const retired = vi.fn();
		old.onversionchange = () => {
			retired();
			old.close();
		};
		const db = await openMtcDb(name);
		expect(retired).toHaveBeenCalledOnce();
		expect(db.version).toBe(DB_VERSION);
		db.close();
		await new Promise((r) => {
			const del = indexedDB.deleteDatabase(name);
			del.onsuccess = del.onerror = () => r(undefined);
		});
	});

	it('version 6 retires a tab still holding version 5 (its out-of-date calendar list would mark the SkillBridge steps)', async () => {
		const name = `mtc-v6-${crypto.randomUUID()}`;
		const old = await openAtVersion(name, 5);
		const retired = vi.fn();
		old.onversionchange = () => {
			retired();
			old.close();
		};
		const db = await openMtcDb(name);
		expect(retired).toHaveBeenCalledOnce();
		expect(db.version).toBe(DB_VERSION);
		db.close();
		await new Promise((r) => {
			const del = indexedDB.deleteDatabase(name);
			del.onsuccess = del.onerror = () => r(undefined);
		});
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
