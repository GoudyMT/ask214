import { STORES, withStores } from './schema';

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
 */
export function wipeAllStores(db: IDBDatabase): Promise<void> {
	return withStores(db, [...STORES], 'readwrite', (tx) => {
		for (const store of STORES) tx.objectStore(store).clear();
	});
}
