import type { CalendarSyncState, DesiredEvent, HandedOverEvent, TaskExclusions } from './types';
import type { CardDismissal } from './card-visibility';
import { encodeCalendarSyncState, decodeCalendarSyncState } from './codec';
import { mergeHandedOver, acknowledge } from './handed-over';
import { encryptRecord, decryptRecord, type RecordCtx } from '../crypto/record-crypto';
import type { KeystoreRecordV1 } from '../keystore/record';
import { signSidecar } from '../profile/sidecars';
import { nextLockState, type LockState, type RelockReason } from '../profile/lifecycle';
import {
	KeystoreNotInitializedError,
	OccConflictError,
	getRow,
	readKeystoreRow,
	readHwmGeneration
} from '../profile/store.svelte';
import { withWriteLocks } from '../db/locks';
import { withStores } from '../db/schema';

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
 *
 * `lastAdd` lives only in this encrypted body, never the signed HWM; like every decrypted field here it is dropped
 * on relock, not zeroized - plain JS strings cannot be zeroized, so dropping the reference is the bar the platform
 * allows.
 */

/** A write was attempted against unloaded/relocked state, where the current record is UNKNOWN. */
export class CalendarRelockedError extends Error {
	constructor() {
		super('E_CALENDAR_RELOCKED');
		this.name = 'CalendarRelockedError';
	}
}

const CALENDAR_CTX: RecordCtx = { storeName: 'calendar-sync', recordId: 'self', schemaVersion: 1 };

type CalendarHwmPayload = {
	generation: number;
	keystoreGeneration: number;
	epoch: number;
	ts: number;
};

type KeystoreRow = KeystoreRecordV1 & { id: number };
type StateRow = { id: number; rec: Uint8Array };

export type CalendarBroadcastEvent = { type: 'calendar-updated' | 'relocked' };
export type CalendarStoreOptions = { onBroadcast?: (e: CalendarBroadcastEvent) => void };

export function createCalendarSyncStore(db: IDBDatabase, opts: CalendarStoreOptions = {}) {
	let _state = $state<CalendarSyncState | null>(null);
	let _generation = 0; // the loaded/written HWM generation, for auto-OCC
	let relockEpoch = 0;
	// How this store came to have no plaintext. `_state === null` says the record is not in memory,
	// never WHY - and the reasons demand opposite answers from a re-read. See refresh().
	let lockState: LockState = 'unlocked';

	function relockNow(reason: RelockReason): void {
		_state = null;
		relockEpoch++;
		lockState = nextLockState(lockState, reason);
		// Only an intentional relock is other tabs' business - see the profile store's relockNow.
		if (reason !== 'hygiene') opts.onBroadcast?.({ type: 'relocked' });
	}

	const readVerifiedKeystore = () => readKeystoreRow(db);
	/** Current calendar generation (0 = no HWM yet = no calendar state written). */
	const readCurrentGeneration = (keystore: KeystoreRow) =>
		readHwmGeneration(db, 'calendar-sync-hwm', keystore.hmacKeyRef);

	/**
	 * Apply `mutate` to the CURRENT record and persist the result. The merge runs INSIDE the write
	 * lock, after the OCC check, so a concurrent setter cannot build on a base that a write which
	 * already landed has superseded (exclusions and the card share one self-row, so a stale base
	 * drops the other field). A null `_state` means "not loaded / relocked" - never "empty" - and a
	 * write against it is refused: relock deliberately leaves `_generation` intact, so OCC cannot
	 * catch such a write, and it would silently persist defaults over the user's real record.
	 */
	async function persist(mutate: (base: CalendarSyncState) => CalendarSyncState): Promise<void> {
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
				if (_state === null) throw new CalendarRelockedError();

				const next = mutate(_state);
				const nextGen = currentGen + 1;
				const blob = await encryptRecord(
					CALENDAR_CTX,
					new Uint8Array(encodeCalendarSyncState(next)),
					keystore,
					nextGen
				);
				const newHwm = await signSidecar<CalendarHwmPayload>(
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
					// eslint-disable-next-line mtc/encrypted-store-registry -- THE sanctioned encryption-boundary write: ciphertext from encryptRecord, under withWriteLocks.
					tx.objectStore('calendar-sync').put({ id: 0, rec: blob });
					tx.objectStore('calendar-sync-hwm').put({ id: 0, ...newHwm });
				});

				_generation = nextGen;
				// Residency guard: a relockSync() during this save must not be undone by
				// re-populating decrypted state (the IDB write already persisted the edit).
				// No lockState update belongs here: the relocked check above means a write only ever
				// runs on a store load() already opened.
				if (relockEpoch === relockAtStart) _state = next;
			}
		);
		opts.onBroadcast?.({ type: 'calendar-updated' });
	}

	const api = {
		/**
		 * Whether the record is loaded and writable. FALSE before the first load, after a relock, and
		 * after a read that failed, when the current record is UNKNOWN. Callers MUST gate on this and fail closed rather than
		 * read the empty defaults below as "the user excluded nothing".
		 */
		get ready(): boolean {
			return _state !== null;
		},

		/** Reactive exclusion set; EMPTY before load / when relocked - gate on `ready` first. */
		get exclusions(): TaskExclusions {
			return _state?.exclusions ?? { taskIds: [], categories: [] };
		},

		/** Reactive card-dismissal bookkeeping; EMPTY before load / when relocked. */
		get card(): CardDismissal {
			return _state?.card ?? {};
		},

		/** Every event handed over and not yet acknowledged; undefined before load, when relocked, or never added. */
		get lastAdd(): HandedOverEvent[] | undefined {
			return _state?.lastAdd;
		},

		/**
		 * Re-read from disk. A relock landing WHILE this runs wins: repopulating decrypted state into
		 * a tab that has since locked silently undoes the lock, and the idle timer does not fire twice.
		 * Same residency guard persist() carries.
		 */
		async load(): Promise<void> {
			const relockAtStart = relockEpoch;
			let ks: KeystoreRow | undefined;
			try {
				await withWriteLocks(
					async () => {
						ks = await readVerifiedKeystore();
						return ks.keystoreGeneration;
					},
					async () => {
						if (!ks) throw new KeystoreNotInitializedError();
						const keystore = ks;
						const gen = await readCurrentGeneration(keystore);
						// The generation moves only with the record it belongs to: a read that fails after a
						// peer's save would otherwise pair the newer generation with the older record, and a
						// write from them would pass the conflict check and lay it over the peer's save.
						if (gen === 0) {
							_generation = gen;
							if (relockEpoch === relockAtStart) {
								_state = { schemaVersion: 1, exclusions: { taskIds: [], categories: [] } };
								lockState = 'unlocked';
							}
							return;
						}
						const row = await getRow<StateRow>(db, 'calendar-sync');
						if (!row) throw new Error('E_CALENDAR_BODY_MISSING');
						const decoded = decodeCalendarSyncState(
							await decryptRecord(CALENDAR_CTX, row.rec, keystore, gen)
						);
						_generation = gen;
						if (relockEpoch === relockAtStart) {
							_state = decoded;
							lockState = 'unlocked';
						}
					}
				);
			} catch (e) {
				// The stored record could not be read, so what is held is no longer known to be current.
				// Say so (not ready, empty defaults) rather than serve it. lockState stays as it was, so
				// the next automatic re-read still tries.
				_state = null;
				throw e;
			}
		},

		/**
		 * AUTOMATIC re-read: a peer tab's change, a page restore, recovery from a failed write. It
		 * DECRYPTS, so it answers to how the plaintext went away, not to whether it is gone.
		 *
		 * Refuses only a `locked` store - the user asked, or their presence lapsed, and re-reading
		 * would reverse that. An `evicted` store lost its plaintext to page hygiene on the way out
		 * and the page has come back, so the re-read is the undo it is owed. An unlocked store
		 * re-reads so a peer's change still lands.
		 *
		 * A hidden page does not decrypt on its own: nobody can see the result, and a page that goes
		 * hidden relocks and comes back through the lifecycle's visible restore, which calls this.
		 * load() is not gated - Unlock and start-up use it, and they are the user asking.
		 */
		refresh(): Promise<void> {
			if (lockState === 'locked' || document.visibilityState === 'hidden') {
				return Promise.resolve();
			}
			return api.load();
		},

		/**
		 * Replace the exclusion set, or update it from the set as saved (preserves the card dismissal state). An
		 * update runs inside the write lock, so quick toggles each build on the one before.
		 */
		setExclusions(
			next: TaskExclusions | ((current: TaskExclusions) => TaskExclusions)
		): Promise<void> {
			return persist((base) => ({
				...base,
				exclusions: typeof next === 'function' ? next(base.exclusions) : next
			}));
		},

		/** Record the events just handed over (merged - see mergeHandedOver). Refused while relocked. */
		recordAdd(events: DesiredEvent[], addedOn: string, todayIso: string): Promise<void> {
			return persist((base) => ({
				...base,
				lastAdd: mergeHandedOver(base.lastAdd, events, addedOn, todayIso)
			}));
		},

		/** The user deleted these from their calendar: forget them. */
		acknowledgeStale(listed: HandedOverEvent[]): Promise<void> {
			return persist((base) => ({ ...base, lastAdd: acknowledge(base.lastAdd ?? [], listed) }));
		},

		/** Record a card dismissal at `now`, incrementing the count (preserves exclusions). */
		dismissCard(now: number): Promise<void> {
			return persist((base) => ({
				...base,
				card: { dismissedAt: now, dismissCount: (base.card?.dismissCount ?? 0) + 1 }
			}));
		},

		/** Sync relock for the pagehide/freeze handlers (wired at app-init) - drop the reference. */
		relockSync(reason: RelockReason): void {
			relockNow(reason);
		},

		/** Clear the calendar-sync + HWM (the keystore is owned by the profile wipe). */
		async wipe(): Promise<void> {
			await withStores(db, ['calendar-sync', 'calendar-sync-hwm'], 'readwrite', (tx) => {
				tx.objectStore('calendar-sync').clear();
				tx.objectStore('calendar-sync-hwm').clear();
			});
			_generation = 0;
			relockNow('user');
		}
	};

	return api;
}

export type CalendarSyncStore = ReturnType<typeof createCalendarSyncStore>;
