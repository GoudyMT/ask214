import type { ProfileV1 } from './types';
import { verifyRecordHmac, type KeystoreRecordV1 } from '../keystore/record';
import { decryptProfileRecord } from './crypto-boundary';
import { verifySidecar, type ProfileHwmPayload, type SignedSidecar } from './sidecars';
import { withWriteLocks } from '../db/locks';
import { withStores, reqToPromise } from '../db/schema';

/**
 * ProfileStore - the orchestration layer over keystore + encryption boundary +
 * IDB. Profile state is held in the factory closure (`_profile`), never exported;
 * Milestone I derives the persona rune from the app's single store instance.
 *
 * load() runs under the hierarchical write locks and is fail-closed: it verifies
 * the keystore-record HMAC, then the signed HWM, BEFORE attempting any decrypt.
 *
 * Source: Phase 2 spec section 4 (invariants) + section 7 (lock ordering).
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

type KeystoreRow = KeystoreRecordV1 & { id: number };
type HwmRow = SignedSidecar<ProfileHwmPayload> & { id: number };
type ProfileRow = { id: number; rec: Uint8Array };

function getRow<T>(
	db: IDBDatabase,
	store: 'keystore' | 'profile-hwm' | 'profile'
): Promise<T | undefined> {
	return withStores(db, store, 'readonly', (tx) =>
		reqToPromise<T | undefined>(tx.objectStore(store).get(0))
	);
}

export function createProfileStore(db: IDBDatabase) {
	let _profile: ProfileV1 | null = null;

	return {
		/** Test-only accessor; production reads go through the persona rune (Milestone I). */
		_getStateForTest(): ProfileV1 | null {
			return _profile;
		},

		async load(): Promise<ProfileV1 | null> {
			let ks: KeystoreRow | undefined;
			return withWriteLocks(
				async () => {
					// Read inside both locks -> authoritative + consistent.
					ks = await getRow<KeystoreRow>(db, 'keystore');
					if (!ks) throw new KeystoreNotInitializedError();
					return ks.keystoreGeneration;
				},
				async () => {
					if (!ks) throw new KeystoreNotInitializedError(); // re-guard (narrows type)
					const keystore = ks;

					// Fail-closed: the keystore record HMAC must verify before any field is trusted.
					if (
						!keystore.recordHmac ||
						!(await verifyRecordHmac(keystore, keystore.hmacKeyRef, keystore.recordHmac))
					) {
						throw new KeystoreHmacMismatchError();
					}

					// Read + verify the HWM sidecar under the single hmacKey.
					const hwmRow = await getRow<HwmRow>(db, 'profile-hwm');
					if (!hwmRow) throw new Error('E_HWM_MISSING');
					const hwm = await verifySidecar<ProfileHwmPayload>(
						'profile-hwm',
						{ v: 1, payload: hwmRow.payload, mac: hwmRow.mac },
						keystore.hmacKeyRef
					);

					// First run: generation 0 = keystore exists, no profile body written yet.
					if (hwm.generation === 0) {
						_profile = null;
						return null;
					}

					// Read + decrypt the body, binding decrypt to the authoritative HWM generation.
					const profRow = await getRow<ProfileRow>(db, 'profile');
					if (!profRow) throw new Error('E_PROFILE_BODY_MISSING');
					_profile = await decryptProfileRecord(profRow.rec, keystore, hwm.generation);
					return _profile;
				}
			);
		}
	};
}
