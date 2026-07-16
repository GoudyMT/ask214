import { STORES, withStores } from './schema';
import { rotateOrUpgrade } from './locks';

/**
 * Erase every registered store in ONE transaction.
 *
 * Keyed on the schema registry, never on which Svelte stores happen to have provisioned. Routing the
 * erase through the store objects skips any store that failed to load - and that is precisely the
 * store whose rows outlive the wipe, still signed under the keystore epoch the wipe destroys. Its
 * HWM then fails to verify forever, so it never loads, so the next erase skips it again: the only
 * recovery is gated on the thing that is broken.
 *
 * One transaction so the keystore cannot die while another store's rows survive it - a partial erase
 * strands exactly the same orphan.
 *
 * Held under the EXCLUSIVE keystore lock, not merely one transaction. A save holds that lock SHARED
 * across its whole encrypt-then-write, and its IDB write lands at the END: an unlocked erase clears
 * first and the save then resurrects its row into a database the user was told was empty. Excluding
 * normal writes makes the erase the last writer, which is the only ordering that can be total.
 */
export function wipeAllStores(db: IDBDatabase): Promise<void> {
	return rotateOrUpgrade(() =>
		withStores(db, [...STORES], 'readwrite', (tx) => {
			for (const store of STORES) tx.objectStore(store).clear();
		})
	);
}
