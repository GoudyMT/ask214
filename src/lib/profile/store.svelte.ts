import type { ProfileV1 } from './types';
import { derivePersona, type PersonaFilters } from './persona';
import { computeRecordHmac, verifyRecordHmac, type KeystoreRecordV1 } from '../keystore/record';
import { decryptProfileRecord, encryptProfileRecord } from './crypto-boundary';
import { signSidecar, verifySidecar, type ProfileHwmPayload, type SignedSidecar } from './sidecars';
import { bumpIvCounter } from '../keystore/iv-counter';
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

/** A write lost an optimistic-concurrency race (HWM generation moved under it). */
export class OccConflictError extends Error {
	constructor() {
		super('E_OCC_CONFLICT');
		this.name = 'OccConflictError';
	}
}

/** Caller-supplied profile edits. The computed fields are owned by save(). */
export type ProfilePatch = Partial<
	Omit<ProfileV1, 'schemaVersion' | 'generation' | 'lastSeenAt' | 'setupIntentChangedAt'>
>;

export type BroadcastEvent = { type: 'profile-updated' };
export type ProfileStoreOptions = { onBroadcast?: (e: BroadcastEvent) => void };

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

export function createProfileStore(db: IDBDatabase, opts: ProfileStoreOptions = {}) {
	let _profile = $state<ProfileV1 | null>(null);

	return {
		/** Test-only accessor; production reads go through the reactive `persona` getter. */
		_getStateForTest(): ProfileV1 | null {
			return _profile;
		},

		/** Reactive persona derived from current profile state (re-runs when load/save mutates it). */
		get persona(): PersonaFilters {
			return derivePersona(_profile);
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
		},

		async save(patch: ProfilePatch): Promise<{ generation: number }> {
			let ks: KeystoreRow | undefined;
			const result = await withWriteLocks(
				async () => {
					ks = await getRow<KeystoreRow>(db, 'keystore');
					if (!ks) throw new KeystoreNotInitializedError();
					return ks.keystoreGeneration;
				},
				async () => {
					if (!ks) throw new KeystoreNotInitializedError();
					const keystore = ks;

					// Fail-closed: verify before trusting/re-signing (prevents laundering a
					// tampered keystore into a freshly-valid record).
					if (
						!keystore.recordHmac ||
						!(await verifyRecordHmac(keystore, keystore.hmacKeyRef, keystore.recordHmac))
					) {
						throw new KeystoreHmacMismatchError();
					}

					// Read + verify the current HWM under the single hmacKey.
					const hwmRow = await getRow<HwmRow>(db, 'profile-hwm');
					if (!hwmRow) throw new Error('E_HWM_MISSING');
					const currentHwm = await verifySidecar<ProfileHwmPayload>(
						'profile-hwm',
						{ v: 1, payload: hwmRow.payload, mac: hwmRow.mac },
						keystore.hmacKeyRef
					);

					// Auto-OCC (merged G4 + concurrent first-run G5): the expected generation is
					// whatever this store instance last loaded or wrote (0 if it never loaded). A
					// mismatch means another writer advanced the HWM, or this instance is stale
					// (e.g. post-relock / a second tab) - so we reject rather than silently clobber.
					// Always-on; there is no opt-out token.
					const expectedGeneration = _profile?.generation ?? 0;
					if (currentHwm.generation !== expectedGeneration) {
						throw new OccConflictError();
					}

					// Stage the next profile from current state + the caller's patch.
					const nextGen = currentHwm.generation + 1;
					const now = Date.now();
					const base: ProfileV1 = _profile ?? {
						schemaVersion: 1,
						generation: 0,
						lastSeenAt: 0,
						setupIntent: 'pending',
						setupIntentChangedAt: null,
						eaos: null
					};
					const nextSetupIntent = patch.setupIntent ?? base.setupIntent;
					const next: ProfileV1 = {
						...base,
						...patch,
						schemaVersion: 1,
						generation: nextGen,
						lastSeenAt: Math.max(now, base.lastSeenAt),
						setupIntent: nextSetupIntent,
						setupIntentChangedAt:
							nextSetupIntent !== base.setupIntent ? now : base.setupIntentChangedAt
					};

					// Bump ivCounter (throws at exhaustion) + re-sign the keystore record.
					const ivBump = bumpIvCounter(keystore.ivCounter);
					const updatedKs: KeystoreRow = { ...keystore, ivCounter: ivBump.newValue };
					updatedKs.recordHmac = await computeRecordHmac(updatedKs, keystore.hmacKeyRef);

					// Encrypt with the UPDATED keystore state bound into the AAD.
					const blob = await encryptProfileRecord(next, updatedKs);

					// Sign the new HWM under the single hmacKey.
					const newHwm = await signSidecar(
						'profile-hwm',
						{
							generation: nextGen,
							keystoreGeneration: keystore.keystoreGeneration,
							epoch: keystore.epoch,
							ts: now
						},
						keystore.hmacKeyRef
					);

					// Atomic write: profile body + HWM + keystore (the ivCounter bump) in one tx.
					await withStores(db, ['profile', 'profile-hwm', 'keystore'], 'readwrite', (tx) => {
						// eslint-disable-next-line mtc/encrypted-store-registry -- THE sanctioned encryption-boundary write: ciphertext from encryptProfileRecord, under withWriteLocks.
						tx.objectStore('profile').put({ id: 0, rec: blob });
						tx.objectStore('profile-hwm').put({ id: 0, ...newHwm });
						tx.objectStore('keystore').put(updatedKs);
					});

					// Commit the rune INSIDE the lock (concurrent tabs are blocked).
					_profile = next;
					return { generation: nextGen };
				}
			);

			// Broadcast AFTER the lock releases (ADR-012).
			opts.onBroadcast?.({ type: 'profile-updated' });
			return result;
		}
	};
}
