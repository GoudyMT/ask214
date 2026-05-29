import { openMtcDb } from './schema';

/** Opens a uniquely-named MtcDb for test isolation (real IndexedDB in Chromium). */
export function openTestDb(): Promise<IDBDatabase> {
	return openMtcDb('mtc-test-' + crypto.randomUUID());
}

/** Closes + deletes a test DB. Call in afterEach so test DBs don't leak. */
export function deleteTestDb(db: IDBDatabase): Promise<void> {
	const name = db.name;
	db.close();
	return new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () => resolve();
		req.onblocked = () => resolve();
	});
}
