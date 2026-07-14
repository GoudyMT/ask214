import type { CalendarSyncState, TaskExclusions } from './types';
import type { CardDismissal } from './card-visibility';
import { encodeCalendarSyncState, decodeCalendarSyncState } from './codec';
import { encryptRecord, decryptRecord, type RecordCtx } from '../crypto/record-crypto';
import { verifyRecordHmac, type KeystoreRecordV1 } from '../keystore/record';
import { signSidecar, verifySidecar, type SignedSidecar } from '../profile/sidecars';
import {
	KeystoreNotInitializedError,
	KeystoreHmacMismatchError,
	OccConflictError
} from '../profile/store.svelte';
import { withWriteLocks } from '../db/locks';
import { withStores, reqToPromise } from '../db/schema';

/**
 * CalendarSyncStore - orchestration over keystore + the generic record-crypto
 * boundary + IDB for the user's calendar exclusion set. Mirrors the timeline-state
 * store's load/save/OCC/relock/wipe spine, leaner still (a single setter). It NEVER
 * mutates the keystore (calendar saves write only calendar-sync + its HWM). State
 * lives in the factory closure (`_state`); never exported.
 *
 * load() is fail-closed: verify the keystore-record HMAC, then the signed HWM,
 * BEFORE any decrypt. A missing calendar-sync-hwm = "no calendar state yet"
 * (generation 0, empty exclusions) - legitimate for a returning user; the HWM is
 * created on first save. Relock drops the in-memory reference; the on-disk record
 * stays encrypted. Reuses withWriteLocks (profile-write exclusive) - safe
 * full-serialization for a single-user app; HWM domain-separation is via the
 * sidecar name ('calendar-sync-hwm').
 */

const CALENDAR_CTX: RecordCtx = { storeName: 'calendar-sync', recordId: 'self', schemaVersion: 1 };

type CalendarHwmPayload = {
	generation: number;
	keystoreGeneration: number;
	epoch: number;
	ts: number;
};

type KeystoreRow = KeystoreRecordV1 & { id: number };
type HwmRow = SignedSidecar<CalendarHwmPayload> & { id: number };
type StateRow = { id: number; rec: Uint8Array };

function getRow<T>(
	db: IDBDatabase,
	store: 'keystore' | 'calendar-sync-hwm' | 'calendar-sync'
): Promise<T | undefined> {
	return withStores(db, store, 'readonly', (tx) =>
		reqToPromise<T | undefined>(tx.objectStore(store).get(0))
	);
}

export type CalendarBroadcastEvent = { type: 'calendar-updated' | 'relocked' };
export type CalendarStoreOptions = { onBroadcast?: (e: CalendarBroadcastEvent) => void };

export function createCalendarSyncStore(db: IDBDatabase, opts: CalendarStoreOptions = {}) {
	let _state = $state<CalendarSyncState | null>(null);
	let _generation = 0; // the loaded/written HWM generation, for auto-OCC
	let relockEpoch = 0;

	function relockNow(): void {
		_state = null;
		relockEpoch++;
		opts.onBroadcast?.({ type: 'relocked' });
	}

	async function readVerifiedKeystore(): Promise<KeystoreRow> {
		const ks = await getRow<KeystoreRow>(db, 'keystore');
		if (!ks) throw new KeystoreNotInitializedError();
		if (!ks.recordHmac || !(await verifyRecordHmac(ks, ks.hmacKeyRef, ks.recordHmac))) {
			throw new KeystoreHmacMismatchError();
		}
		return ks;
	}

	/** Current calendar generation (0 = no HWM yet = no calendar state written). */
	async function readCurrentGeneration(keystore: KeystoreRow): Promise<number> {
		const hwmRow = await getRow<HwmRow>(db, 'calendar-sync-hwm');
		if (!hwmRow) return 0;
		const hwm = await verifySidecar<CalendarHwmPayload>(
			'calendar-sync-hwm',
			{ v: 1, payload: hwmRow.payload, mac: hwmRow.mac },
			keystore.hmacKeyRef
		);
		return hwm.generation;
	}

	async function persist(next: CalendarSyncState): Promise<void> {
		const relockAtStart = relockEpoch;
		let ks: KeystoreRow | undefined;
		await withWriteLocks(
			async () => {
				ks = await readVerifiedKeystore();
				return ks.keystoreGeneration;
			},
			async () => {
				if (!ks) throw new KeystoreNotInitializedError();
				const keystore = ks;

				const currentGen = await readCurrentGeneration(keystore);
				if (currentGen !== _generation) throw new OccConflictError();

				const nextGen = currentGen + 1;
				const blob = await encryptRecord(
					CALENDAR_CTX,
					new Uint8Array(encodeCalendarSyncState(next)),
					keystore,
					nextGen
				);
				const newHwm = await signSidecar(
					'calendar-sync-hwm',
					{
						generation: nextGen,
						keystoreGeneration: keystore.keystoreGeneration,
						epoch: keystore.epoch,
						ts: Date.now()
					},
					keystore.hmacKeyRef
				);

				await withStores(db, ['calendar-sync', 'calendar-sync-hwm'], 'readwrite', (tx) => {
					tx.objectStore('calendar-sync').put({ id: 0, rec: blob });
					tx.objectStore('calendar-sync-hwm').put({ id: 0, ...newHwm });
				});

				_generation = nextGen;
				// Residency guard: a relockSync() during this save must not be undone by
				// re-populating decrypted state (the IDB write already persisted the edit).
				if (relockEpoch === relockAtStart) _state = next;
			}
		);
		opts.onBroadcast?.({ type: 'calendar-updated' });
	}

	/**
	 * Merge a partial change over the CURRENT record so one setter never clobbers the other's
	 * field - exclusions and the card dismissal share the single self-row.
	 */
	function nextState(patch: Partial<Omit<CalendarSyncState, 'schemaVersion'>>): CalendarSyncState {
		const exclusions = patch.exclusions ?? _state?.exclusions ?? { taskIds: [], categories: [] };
		const card = patch.card ?? _state?.card;
		return { schemaVersion: 1, exclusions, ...(card ? { card } : {}) };
	}

	const api = {
		/** Reactive exclusion set; EMPTY before load / when relocked. */
		get exclusions(): TaskExclusions {
			return _state?.exclusions ?? { taskIds: [], categories: [] };
		},

		/** Reactive card-dismissal bookkeeping; EMPTY before load / when relocked. */
		get card(): CardDismissal {
			return _state?.card ?? {};
		},

		async load(): Promise<void> {
			let ks: KeystoreRow | undefined;
			await withWriteLocks(
				async () => {
					ks = await readVerifiedKeystore();
					return ks.keystoreGeneration;
				},
				async () => {
					if (!ks) throw new KeystoreNotInitializedError();
					const keystore = ks;
					const gen = await readCurrentGeneration(keystore);
					_generation = gen;
					if (gen === 0) {
						_state = { schemaVersion: 1, exclusions: { taskIds: [], categories: [] } };
						return;
					}
					const row = await getRow<StateRow>(db, 'calendar-sync');
					if (!row) throw new Error('E_CALENDAR_BODY_MISSING');
					_state = decodeCalendarSyncState(
						await decryptRecord(CALENDAR_CTX, row.rec, keystore, gen)
					);
				}
			);
		},

		/** Replace the exclusion set (preserves the card dismissal state). */
		setExclusions(exclusions: TaskExclusions): Promise<void> {
			return persist(nextState({ exclusions }));
		},

		/** Record a card dismissal at `now`, incrementing the count (preserves exclusions). */
		dismissCard(now: number): Promise<void> {
			const dismissCount = (_state?.card?.dismissCount ?? 0) + 1;
			return persist(nextState({ card: { dismissedAt: now, dismissCount } }));
		},

		/** Sync relock for the pagehide/freeze handlers (wired at app-init) - drop the reference. */
		relockSync(): void {
			relockNow();
		},

		/** Clear the calendar-sync + HWM (the keystore is owned by the profile wipe). */
		async wipe(): Promise<void> {
			await withStores(db, ['calendar-sync', 'calendar-sync-hwm'], 'readwrite', (tx) => {
				tx.objectStore('calendar-sync').clear();
				tx.objectStore('calendar-sync-hwm').clear();
			});
			_generation = 0;
			relockNow();
		}
	};

	return api;
}

export type CalendarSyncStore = ReturnType<typeof createCalendarSyncStore>;
