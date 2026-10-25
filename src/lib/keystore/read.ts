import { withStores, reqToPromise } from '../db/schema';
import { verifyKeystore, type KeystoreKeys, type KeystoreRecordV1 } from './record';

/**
 * The one place a reader gets the keys it may use. A reader never reaches into a row for a
 * key handle: it asks for the row's keys here, so a later lock mode can decide where the
 * keys come from without any reader changing.
 */
export class KeystoreNotInitializedError extends Error {
	constructor() {
		super('E_KEYSTORE_NOT_INITIALIZED');
		this.name = 'KeystoreNotInitializedError';
	}
}

export class KeystoreHmacMismatchError extends Error {
	constructor() {
		super('E_KEYSTORE_HMAC_MISMATCH');
		this.name = 'KeystoreHmacMismatchError';
	}
}

export type KeystoreRow = KeystoreRecordV1 & { id: number };

/** The keys this tab may use with `row`. Local mode: the row's own key handles. */
export function keysForRow(row: KeystoreRow): KeystoreKeys {
	return { dataKey: row.dataKeyRef, hmacKey: row.hmacKeyRef, bootstrapMacKey: row.hmacKeyRef };
}

/** The keystore row, verified: a missing or tampered keystore stops the read, never silently succeeds. */
export async function readKeystoreRow(
	db: IDBDatabase
): Promise<{ row: KeystoreRow; keys: KeystoreKeys }> {
	const row = await withStores(db, 'keystore', 'readonly', (tx) =>
		reqToPromise<KeystoreRow | undefined>(tx.objectStore('keystore').get(0))
	);
	if (!row) throw new KeystoreNotInitializedError();
	const keys = keysForRow(row);
	if (!(await verifyKeystore(row, keys))) throw new KeystoreHmacMismatchError();
	return { row, keys };
}
