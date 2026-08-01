import { encryptRecord, decryptRecord, type RecordCtx } from '$lib/crypto/record-crypto';
import { verifyRecordHmac, type KeystoreRecordV1 } from '$lib/keystore/record';
import { KeystoreNotInitializedError, KeystoreHmacMismatchError } from '$lib/profile/store.svelte';
import { withStores, reqToPromise } from '$lib/db/schema';

/**
 * byok store - persists the user's BYO API key as ONE encrypted self-row through the shared
 * record-crypto boundary (AES-GCM under the keystore dataKeyRef). Unlike the profile/timeline/calendar
 * stores it carries NO HWM sidecar and NO in-memory cache: a single re-enterable key needs no OCC or
 * anti-rollback generation, and a raw secret is safer decrypted on demand than held resident for the
 * session. The AAD's storeName binding still isolates a byok record from every other store's ciphertext.
 */

const BYOK_CTX: RecordCtx = { storeName: 'byok', recordId: 'self', schemaVersion: 1 };
// Fixed: with no HWM there is no generation to track - the key is a single, overwritten self-row.
const BYOK_GENERATION = 1;

type KeystoreRow = KeystoreRecordV1 & { id: number };
type KeyRow = { id: number; rec: Uint8Array };

export function createByokStore(db: IDBDatabase) {
	// Fail-closed: a missing or tampered keystore must stop the read/write, never silently succeed.
	async function readVerifiedKeystore(): Promise<KeystoreRow> {
		const ks = await withStores(db, 'keystore', 'readonly', (tx) =>
			reqToPromise<KeystoreRow | undefined>(tx.objectStore('keystore').get(0))
		);
		if (!ks) throw new KeystoreNotInitializedError();
		if (!ks.recordHmac || !(await verifyRecordHmac(ks, ks.hmacKeyRef, ks.recordHmac))) {
			throw new KeystoreHmacMismatchError();
		}
		return ks;
	}

	return {
		/** Encrypt + persist the API key as the single byok self-row. */
		async saveApiKey(key: string): Promise<void> {
			const keystore = await readVerifiedKeystore();
			const blob = await encryptRecord(
				BYOK_CTX,
				new TextEncoder().encode(key),
				keystore,
				BYOK_GENERATION
			);
			await withStores(db, 'byok', 'readwrite', (tx) => {
				// eslint-disable-next-line mtc/encrypted-store-registry -- THE sanctioned encryption-boundary write: ciphertext from encryptRecord.
				tx.objectStore('byok').put({ id: 0, rec: blob });
			});
		},

		/** Decrypt + return the stored key, or null if none is set. Reads on demand; never cached. */
		async readApiKey(): Promise<string | null> {
			const keystore = await readVerifiedKeystore();
			const row = await withStores(db, 'byok', 'readonly', (tx) =>
				reqToPromise<KeyRow | undefined>(tx.objectStore('byok').get(0))
			);
			if (!row) return null;
			const bytes = await decryptRecord(BYOK_CTX, row.rec, keystore, BYOK_GENERATION);
			return new TextDecoder().decode(bytes);
		},

		/** Remove the stored key. */
		async clearApiKey(): Promise<void> {
			await withStores(db, 'byok', 'readwrite', (tx) => {
				tx.objectStore('byok').clear();
			});
		}
	};
}

export type ByokStore = ReturnType<typeof createByokStore>;
