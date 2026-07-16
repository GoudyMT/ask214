import { describe, it, expect } from 'vitest';
import { wipeAllStores } from './wipe';
import { withStores, reqToPromise, STORES } from './schema';
import { LOCK_TIMEOUT_MS } from './locks';
import { openTestDb, deleteTestDb } from './_test-helpers';

describe('wipeAllStores', () => {
	it('clears every registered store, including ones no Svelte store provisioned', async () => {
		const db = await openTestDb();

		// Stage a row in every store, then wipe with no store objects involved at all. The bug this
		// guards: routing the wipe through `app.calendar?.wipe()` skips the store when it failed to
		// load - and a store that failed to load is exactly the one holding rows signed under the
		// keystore epoch the wipe destroys. It can then never load, so it can never be wiped.
		await withStores(db, [...STORES], 'readwrite', (tx) => {
			for (const store of STORES) tx.objectStore(store).put({ id: 0, marker: store });
		});

		await wipeAllStores(db);

		for (const store of STORES) {
			const row = await withStores(db, store, 'readonly', (tx) =>
				reqToPromise<unknown>(tx.objectStore(store).get(0))
			);
			expect(row, `${store} still holds a row after the wipe`).toBeUndefined();
		}
		await deleteTestDb(db);
	});

	it('waits for an in-flight write, so a save cannot land its row after the erase', async () => {
		const db = await openTestDb();
		await withStores(db, 'keystore', 'readwrite', (tx) => {
			tx.objectStore('keystore').put({ id: 0, marker: 'original' });
		});

		// A save in flight holds mtc-keystore SHARED across its whole encrypt-then-write. Its IDB
		// write lands LAST - after the erase has already been asked to run. Without an exclusive
		// lock the erase clears first and the save then resurrects its row into a wiped database.
		let wrote = false;
		const save = navigator.locks.request(
			'mtc-keystore',
			{ mode: 'shared', signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
			async () => {
				await new Promise((r) => setTimeout(r, 60));
				await withStores(db, 'keystore', 'readwrite', (tx) => {
					tx.objectStore('keystore').put({ id: 0, marker: 'resurrected' });
				});
				wrote = true;
			}
		);

		const wipe = wipeAllStores(db);
		await Promise.all([save, wipe]);

		expect(wrote).toBe(true);
		const row = await withStores(db, 'keystore', 'readonly', (tx) =>
			reqToPromise<unknown>(tx.objectStore('keystore').get(0))
		);
		expect(row, 'a row survived "erase everything"').toBeUndefined();
		await deleteTestDb(db);
	});

	it('leaves nothing behind when a store was never written', async () => {
		const db = await openTestDb();
		await withStores(db, 'keystore', 'readwrite', (tx) => {
			tx.objectStore('keystore').put({ id: 0, marker: 'only-this-one' });
		});

		// Clearing an already-empty store must not throw, or one untouched store aborts the whole
		// transaction and the erase silently half-completes.
		await expect(wipeAllStores(db)).resolves.toBeUndefined();

		const ks = await withStores(db, 'keystore', 'readonly', (tx) =>
			reqToPromise<unknown>(tx.objectStore('keystore').get(0))
		);
		expect(ks).toBeUndefined();
		await deleteTestDb(db);
	});
});
