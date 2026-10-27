import { reqToPromise, withStores } from '../db/schema';
import { readCounterIn } from './app-lock-store';
import type { KeystoreRow } from './read';

/**
 * The keystore row and the lock counter as one pair, read in one transaction. Needs no key and no session: the unlock
 * reads it before it has either. The row is whatever is stored (or nothing), so the caller checks the mode.
 */
export function readPinRowAndCounter(
	db: IDBDatabase
): Promise<{ row: KeystoreRow | undefined; counter: number }> {
	return withStores(db, ['keystore', 'app-lock'], 'readonly', async (tx) => {
		const [row, counter] = await Promise.all([
			reqToPromise<KeystoreRow | undefined>(tx.objectStore('keystore').get(0)),
			readCounterIn(tx)
		]);
		return { row, counter };
	});
}
