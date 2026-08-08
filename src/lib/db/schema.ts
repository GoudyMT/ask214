/**
 * MTC v1 IndexedDB schema + the thin promise/transaction layer that is the ONLY
 * place raw IndexedDB request/transaction plumbing lives. v1.0 ships 8 stores
 * (journal + meta deferred to v1.1 with key rotation):
 *
 *   - profile             ciphertext, single self-row (id = 0)
 *   - profile-hwm         signed HWM sidecar, single row (id = 0)
 *   - keystore            KeystoreRecordV1, single row (id = 0)
 *   - timeline-state      ciphertext (task state + notes), single self-row (id = 0)
 *   - timeline-state-hwm  signed HWM sidecar for timeline-state (id = 0)
 *   - calendar-sync       ciphertext (calendar exclusion set), single self-row (id = 0)
 *   - calendar-sync-hwm   signed HWM sidecar for calendar-sync (id = 0)
 *   - byok                ciphertext (BYO API key), single self-row (id = 0); no HWM -
 *                         a re-enterable key needs no OCC/anti-rollback generation
 *
 * Raw IndexedDB (no Dexie) honors the v2 audit "0 new prod deps" lock; the schema
 * is trivial (single-row stores, no indexes/queries) so a library adds no value.
 */
export const DB_NAME = 'mtc';
export const DB_VERSION = 4; // 3 -> 4: adds the byok store (the upgrade loop creates missing stores; prior data survives)
export const STORES = [
	'profile',
	'profile-hwm',
	'keystore',
	'timeline-state',
	'timeline-state-hwm',
	'calendar-sync',
	'calendar-sync-hwm',
	'byok'
] as const;
export type StoreName = (typeof STORES)[number];

export function openMtcDb(
	name: string = DB_NAME,
	onVersionChange?: () => void
): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(name, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			for (const store of STORES) {
				if (!db.objectStoreNames.contains(store)) {
					db.createObjectStore(store, { keyPath: 'id' });
				}
			}
		};
		req.onsuccess = () => {
			const db = req.result;
			// This connection is held for the tab's whole lifetime, and IndexedDB will not upgrade a
			// database while any connection stays open: the other tab gets `blocked`, not an upgrade.
			// Step aside so a tab on a newer bundle can migrate instead of deadlocking. Reads after
			// this throw InvalidStateError, which is correct - that bundle's schema is stale. The
			// optional callback lets the caller surface a reload prompt before those reads fail; it
			// only ever fires in a tab whose bundle already carries this handler, so it protects the
			// NEXT upgrade onward, never the one that ships it.
			db.onversionchange = () => {
				onVersionChange?.();
				db.close();
			};
			resolve(db);
		};
		req.onerror = () => reject(req.error ?? new Error('idb-open-failed'));
		req.onblocked = () => reject(new Error('idb-open-blocked'));
	});
}

export function closeMtcDb(db: IDBDatabase): void {
	db.close();
}

/**
 * Runs `fn` inside ONE IDB transaction over `stores`, resolving only after the
 * transaction COMMITS (real durability + cross-store atomicity). A throw inside
 * `fn` - synchronous OR via a rejected returned promise - aborts the transaction
 * so nothing partial persists. Contract: issue IDB requests synchronously inside
 * `fn`; do not await non-IDB work mid-transaction (IDB auto-commits on idle).
 */
export function withStores<T>(
	db: IDBDatabase,
	stores: StoreName | StoreName[],
	mode: IDBTransactionMode,
	fn: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const tx = db.transaction(stores, mode);
		let result: T;
		let settled = false;

		const fail = (err: unknown) => {
			settled = true;
			try {
				tx.abort();
			} catch {
				/* tx already inactive/aborting */
			}
			reject(err);
		};

		tx.oncomplete = () => resolve(result);
		tx.onerror = () => reject(tx.error ?? new Error('idb-tx-failed'));
		tx.onabort = () => {
			if (!settled) reject(tx.error ?? new Error('idb-tx-aborted'));
		};

		let out: Promise<T> | T;
		try {
			out = fn(tx);
		} catch (err) {
			fail(err);
			return;
		}
		Promise.resolve(out)
			.then((r) => {
				result = r;
			})
			.catch(fail);
	});
}

/** Promise wrapper for a single IDBRequest. */
export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('idb-request-failed'));
	});
}
