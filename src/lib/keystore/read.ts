import { withStores, reqToPromise } from '../db/schema';
import { readCounterIn } from './app-lock-store';
import {
	keyIdentity,
	keyIdentityBytes,
	verifyKeystore,
	type KeyIdentity,
	type KeystoreKeys,
	type KeystoreRecord
} from './record';
import { failMismatch, getSession, inOwnKeyChange, KeystoreLockedError } from './session';

/**
 * The one place a reader gets the keys it may use. A reader never reaches into a row for a
 * key handle: it asks for the row's keys here, so the lock mode decides where the keys
 * come from without any reader changing.
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

export type KeystoreRow = KeystoreRecord & { id: number };

function sameIdentity(a: KeyIdentity, b: KeyIdentity): boolean {
	const x = keyIdentityBytes(a);
	const y = keyIdentityBytes(b);
	return x.length === y.length && x.every((byte, i) => byte === y[i]);
}

/**
 * The keys this tab may use with `row`. A local row, with no session: its own key handles. A PIN row: the live session's
 * keys, or KeystoreLockedError when there is no session. A row that does not fit the session (a local row under a PIN
 * session, or a PIN row of another generation, epoch or install) means another tab changed the lock under this one: the
 * session is dropped, the app is told to relock, and the read is refused. During this tab's own key change the row is
 * refused the same way but the session stays, since the caller is the one changing it.
 *
 * Synchronous, so it can run inside a transaction. It cannot read the lock counter there (that needs an await); the
 * readers that can, go through readKeystoreRow, which checks it.
 */
export function keysForRow(row: KeystoreRow): KeystoreKeys {
	const session = getSession();
	if (row.mode === 'pin') {
		if (!session) throw new KeystoreLockedError();
		if (!sameIdentity(keyIdentity(row), session.identity)) {
			if (inOwnKeyChange()) throw new KeystoreLockedError();
			failMismatch();
		}
		return {
			dataKey: session.dataKey,
			hmacKey: session.hmacKey,
			bootstrapMacKey: session.bootstrapMacKey
		};
	}
	if (session && !inOwnKeyChange()) failMismatch();
	return { dataKey: row.dataKeyRef, hmacKey: row.hmacKeyRef, bootstrapMacKey: row.hmacKeyRef };
}

/**
 * The keystore row, verified, with the keys to use with it. A missing keystore, a tampered one, a locked tab and a lock
 * that changed under a live session each stop the read, never silently succeed.
 */
export async function readKeystoreRow(
	db: IDBDatabase
): Promise<{ row: KeystoreRow; keys: KeystoreKeys }> {
	// One transaction, so the row and the counter are a pair that was true at one moment.
	const { row, counter } = await withStores(
		db,
		['keystore', 'app-lock'],
		'readonly',
		async (tx) => {
			const [stored, now] = await Promise.all([
				reqToPromise<KeystoreRow | undefined>(tx.objectStore('keystore').get(0)),
				readCounterIn(tx)
			]);
			return { row: stored, counter: now };
		}
	);
	if (!row) throw new KeystoreNotInitializedError();
	const keys = keysForRow(row);
	const session = getSession();
	// Any difference counts, not only a higher number: a wipe writes old + 1, a restore may write anything.
	if (session && counter !== session.counter) {
		if (inOwnKeyChange()) throw new KeystoreLockedError();
		failMismatch();
	}
	if (!(await verifyKeystore(row, keys))) throw new KeystoreHmacMismatchError();
	return { row, keys };
}
