import type { ProfileV1 } from './types';
import { derivePersona, type PersonaFilters } from './persona';
import { computeRecordHmac, verifyRecordHmac, type KeystoreRecordV1 } from '../keystore/record';
import { decryptProfileRecord, encryptProfileRecord } from './crypto-boundary';
import { signSidecar, verifySidecar, type ProfileHwmPayload, type SignedSidecar } from './sidecars';
import { bumpIvCounter } from '../keystore/iv-counter';
import { withWriteLocks } from '../db/locks';
import { withStores, reqToPromise } from '../db/schema';
import { freezeRelock, cloneField } from './lifecycle';
import { updateLastSeen, isClockBackward } from './clock';
import { safeLog } from '../log/safelog';

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

export type BroadcastEvent = { type: 'profile-updated' | 'relocked' };
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
	let saveInFlight = false;
	let pendingRelock = false;
	let relockEpoch = 0;
	// True once a profile body exists in storage (generation >= 1). Retained across relock
	// (the encrypted record still exists), so `locked` can distinguish relocked from never-set-up.
	let hasProfile = false;

	// Synchronous relock core: zeroize the in-memory profile bytes, drop the reference,
	// then signal relocked. Shared by relockSync() (the sync pagehide/freeze handlers),
	// lock() (async UI / idle / cross-tab), and the deferred-relock path at save() exit.
	// Zeroizes BEFORE nulling (memory-hygiene order; spec section 11).
	function relockNow(): void {
		if (_profile) {
			freezeRelock(_profile as unknown as Record<string, unknown>);
			_profile = null;
		}
		// Bump the relock epoch so an in-flight save can detect a relock happened during it
		// and skip re-populating _profile afterward (PII-residency guard, L1).
		relockEpoch++;
		opts.onBroadcast?.({ type: 'relocked' });
	}

	const api = {
		/** Test-only accessor; production reads go through the reactive `persona` getter. */
		_getStateForTest(): ProfileV1 | null {
			return _profile;
		},

		/** Reactive persona derived from current profile state (re-runs when load/save mutates it). */
		get persona(): PersonaFilters {
			return derivePersona(_profile);
		},

		/** Synchronous relock for the pagehide/freeze handlers (wired at app-init) - no await. */
		relockSync(): void {
			relockNow();
		},

		/**
		 * Async relock for the Settings "Lock" button, idle timeout, and cross-tab signal
		 * (all wired at app-init). If a save is in flight, the relock is DEFERRED until that
		 * save finishes (F-3-C-11: never interrupt an in-progress encrypt/write); otherwise it
		 * runs immediately. Resolves immediately so callers may `await store.lock()`.
		 */
		lock(): Promise<void> {
			if (saveInFlight) {
				pendingRelock = true;
			} else {
				relockNow();
			}
			return Promise.resolve();
		},

		/** Reactive backward-clock signal: true when the stored lastSeenAt sits in the future past the grace window. */
		get clockBackward(): boolean {
			return _profile ? isClockBackward(_profile.lastSeenAt) : false;
		},

		/**
		 * Reactive locked signal: a profile exists in storage but not in memory (relocked).
		 * Distinguishes "locked - unlock to view" from "never set up" (both have _profile null).
		 * Unlock is a re-load (load() re-decrypts from the local key; no passphrase in v1.0).
		 */
		get locked(): boolean {
			return hasProfile && _profile === null;
		},

		/**
		 * "I fixed my clock" reset. Forcibly lower lastSeenAt to now - the ONE sanctioned
		 * retreat of the monotonic mark - and persist it durably (else the stored future mark
		 * re-triggers the warning on every reload). No-op when no profile is loaded.
		 */
		async clearClockBackward(): Promise<void> {
			if (!_profile) return;
			_profile.lastSeenAt = Date.now();
			safeLog({ code: 'E_CLOCK_BACKWARD' });
			await api.save({});
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
						hasProfile = false;
						return null;
					}

					// Read + decrypt the body, binding decrypt to the authoritative HWM generation.
					const profRow = await getRow<ProfileRow>(db, 'profile');
					if (!profRow) throw new Error('E_PROFILE_BODY_MISSING');
					_profile = await decryptProfileRecord(profRow.rec, keystore, hwm.generation);
					hasProfile = true;
					return _profile;
				}
			);
		},

		async save(patch: ProfilePatch): Promise<{ generation: number }> {
			saveInFlight = true;
			const relockAtStart = relockEpoch;
			try {
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
							lastSeenAt: updateLastSeen(base.lastSeenAt, now),
							setupIntent: nextSetupIntent,
							setupIntentChangedAt:
								nextSetupIntent !== base.setupIntent ? now : base.setupIntentChangedAt
						};

						// Decouple the staged record from _profile: deep-copy byte fields so a concurrent
						// relockSync() zeroizing _profile in place cannot corrupt this record before it is
						// encoded + encrypted (L1 corruption guard).
						for (const k of Object.keys(next)) {
							(next as Record<string, unknown>)[k] = cloneField(
								(next as Record<string, unknown>)[k]
							);
						}

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

						// A profile body now exists in storage (generation >= 1). Record it so the
						// locked signal can tell "relocked - unlock to view" from "never set up" even
						// after a relock nulls _profile.
						hasProfile = true;

						// Commit the rune INSIDE the lock (concurrent tabs are blocked) - but ONLY if
						// no relock happened during this save. A sync relockSync() (pagehide/freeze)
						// mid-save must not be undone by re-populating decrypted PII; the IDB write
						// above still persisted, so the user's edit is not lost (L1 residency guard).
						if (relockEpoch === relockAtStart) {
							_profile = next;
						}
						return { generation: nextGen };
					}
				);

				// Broadcast AFTER the lock releases (ADR-012).
				opts.onBroadcast?.({ type: 'profile-updated' });
				return result;
			} finally {
				saveInFlight = false;
				// A relock requested during the save was deferred; run it now the write is done.
				if (pendingRelock) {
					pendingRelock = false;
					relockNow();
				}
			}
		},

		/**
		 * Destroy all local data: clear the encrypted stores (keys + profile + HWM), reset the
		 * profile-exists flag, then relock memory. The store is intentionally unusable afterward
		 * (no keystore) - the caller reloads to bootstrap a fresh first-run. v1.0 alternative to
		 * profile export (master spec section 7.6).
		 */
		async wipe(): Promise<void> {
			await withStores(db, ['keystore', 'profile', 'profile-hwm'], 'readwrite', (tx) => {
				tx.objectStore('keystore').clear();
				tx.objectStore('profile').clear();
				tx.objectStore('profile-hwm').clear();
			});
			hasProfile = false;
			relockNow();
		}
	};

	return api;
}

/** The wired profile-store instance shape (the createProfileStore return value). */
export type ProfileStore = ReturnType<typeof createProfileStore>;
