import { computeRecordHmac, type KeystoreRecordV1 } from './record';
import { signSidecar } from '../profile/sidecars';
import { withStores, reqToPromise } from '../db/schema';

export class KeystoreAlreadyExistsError extends Error {
	constructor() {
		super('E_KEYSTORE_ALREADY_EXISTS');
		this.name = 'KeystoreAlreadyExistsError';
	}
}

/**
 * First-run local-mode bootstrap: generate the data + HMAC keys (both
 * extractable:false), build + HMAC-sign the v1 keystore record, and write it
 * with the initial profile-hwm sidecar in ONE transaction so a partial first
 * run can never persist. Atomic idempotency: the keystore-exists check runs
 * inside that same write transaction, closing the TOCTOU window.
 *
 * Source: Phase 2 spec section 6; ADR-009 v1.0 scope; plan v2 T6-E (2 keys,
 * single hmacKey) + F1 raw-IDB layer.
 */
export async function bootstrapLocalKeystore(
	db: IDBDatabase
): Promise<{ record: KeystoreRecordV1 }> {
	// Keys first - async crypto cannot run mid-transaction.
	const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
		'encrypt',
		'decrypt'
	]);
	const hmacKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);

	const installUuid = new Uint8Array(16);
	crypto.getRandomValues(installUuid);

	const recordWithoutHmac: Omit<KeystoreRecordV1, 'recordHmac'> = {
		v: 1,
		mode: 'local',
		keystoreGeneration: 0,
		epoch: 0,
		ivCounter: 0,
		installUuid,
		dataKeyRef: dataKey,
		hmacKeyRef: hmacKey
	};
	const recordHmac = await computeRecordHmac(recordWithoutHmac, hmacKey);
	const record: KeystoreRecordV1 = { ...recordWithoutHmac, recordHmac };

	const initialHwm = await signSidecar(
		'profile-hwm',
		{ generation: 0, keystoreGeneration: 0, epoch: 0, ts: Date.now() },
		hmacKey
	);

	// Atomic first-run write + idempotency guard in one transaction.
	await withStores(db, ['keystore', 'profile-hwm'], 'readwrite', async (tx) => {
		const existing = await reqToPromise(tx.objectStore('keystore').get(0));
		if (existing) throw new KeystoreAlreadyExistsError();
		tx.objectStore('keystore').put({ id: 0, ...record });
		tx.objectStore('profile-hwm').put({ id: 0, ...initialHwm });
	});

	return { record };
}
