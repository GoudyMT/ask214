import type { Listing } from '../contract/listing';
import {
	MAX_COMPARE,
	MAX_SAVED,
	type FinderFilters,
	type FinderRecord,
	type FinderSetup
} from './types';
import { encryptFinderRecord, decryptFinderRecord } from './crypto-boundary';
import type { KeystoreRecordV1 } from '../../keystore/record';
import { signSidecar, verifySidecar, type SignedSidecar } from '../../profile/sidecars';
import { nextLockState, type LockState, type RelockReason } from '../../profile/lifecycle';
import {
	KeystoreNotInitializedError,
	OccConflictError,
	getRow,
	readKeystoreRow
} from '../../profile/store.svelte';
import { withWriteLocks } from '../../db/locks';
import { withStores } from '../../db/schema';

/**
 * FinderStore - orchestration over keystore + the generic record-crypto boundary + IDB for the SkillBridge finder's
 * personal record: where the person is looking, the programs they saved, the ones they compare and their filters.
 * Same spine as the calendar-sync store (load / save / OCC / relock / wipe), and like it NEVER mutates the keystore
 * (a save writes only skillbridge-finder + its HWM). State lives in the factory closure (`_state`); never exported.
 *
 * load() is fail-closed: verify the keystore-record HMAC, then the signed HWM, BEFORE any decrypt. A missing
 * skillbridge-finder-hwm = "nothing saved yet" (generation 0, empty record) - legitimate for a first visit; the HWM is
 * created on first save. An HWM with no body is a deleted record and fails the load. Relock drops the in-memory
 * reference; the on-disk record stays encrypted.
 */

/** A write was attempted against unloaded/relocked state, where the current record is UNKNOWN. */
export class FinderRelockedError extends Error {
	constructor() {
		super('E_FINDER_RELOCKED');
	}
}

type FinderHwmPayload = {
	generation: number;
	keystoreGeneration: number;
	epoch: number;
	ts: number;
};

type KeystoreRow = KeystoreRecordV1 & { id: number };
type StateRow = { id: number; rec: Uint8Array };

export type FinderBroadcastEvent = {
	type: 'skillbridge-finder-updated' | 'relocked';
	reason?: 'idle' | 'user';
};
export type FinderStoreOptions = { onBroadcast?: (e: FinderBroadcastEvent) => void };

const HWM_STORE = 'skillbridge-finder-hwm';
const EMPTY_RECORD = (): FinderRecord => ({ schemaVersion: 1, finderSaved: [], finderCompare: [] });

export function createFinderStore(db: IDBDatabase, opts: FinderStoreOptions = {}) {
	let _state = $state<FinderRecord | null>(null);
	// Whether the last load failed: not loaded can mean not read YET, which a page waits out, or could not be read,
	// which it says.
	let _failed = $state(false);
	let _generation = 0; // the loaded/written HWM generation, for auto-OCC
	let relockEpoch = 0;
	// How this store came to have no plaintext. `_state === null` says the record is not in memory, never WHY - and the
	// reasons demand opposite answers from a re-read. See refresh().
	let lockState = $state<LockState>('unlocked');

	function relockNow(reason: RelockReason): void {
		_state = null;
		relockEpoch++;
		lockState = nextLockState(lockState, reason);
		// Only an intentional relock is other tabs' business - see the profile store's relockNow.
		if (reason === 'idle' || reason === 'user') opts.onBroadcast?.({ type: 'relocked', reason });
		else if (reason !== 'hygiene') opts.onBroadcast?.({ type: 'relocked' });
	}

	/** Current finder generation from its verified HWM sidecar (0 = no HWM yet = nothing written). */
	async function readCurrentGeneration(keystore: KeystoreRow): Promise<number> {
		const row = await getRow<SignedSidecar<FinderHwmPayload>>(db, HWM_STORE);
		if (!row) return 0;
		const hwm = await verifySidecar<FinderHwmPayload>(
			HWM_STORE,
			{ v: 1, payload: row.payload, mac: row.mac },
			keystore.hmacKeyRef
		);
		return hwm.generation;
	}

	/**
	 * Apply `mutate` to the CURRENT record and persist the result. The merge runs INSIDE the write lock, after the OCC
	 * check, so a concurrent setter cannot build on a base that a write which already landed has superseded, and a cap
	 * is judged on the record as it stands. A null `_state` means "not loaded / relocked" - never "empty" - and a write
	 * against it is refused: relock deliberately leaves `_generation` intact, so OCC cannot catch such a write, and it
	 * would silently persist defaults over the person's real record. A `mutate` that returns its base changes nothing
	 * and writes nothing.
	 */
	async function persist(mutate: (base: FinderRecord) => FinderRecord): Promise<void> {
		const relockAtStart = relockEpoch;
		let ks: KeystoreRow | undefined;
		let wrote = false;
		await withWriteLocks(
			async () => {
				ks = await readKeystoreRow(db);
				return ks.keystoreGeneration;
			},
			async () => {
				if (!ks) throw new KeystoreNotInitializedError();
				const keystore = ks;

				const currentGen = await readCurrentGeneration(keystore);
				if (currentGen !== _generation) throw new OccConflictError();
				if (_state === null) throw new FinderRelockedError();

				const next = mutate(_state);
				if (next === _state) return;
				const nextGen = currentGen + 1;
				const blob = await encryptFinderRecord(next, keystore, nextGen);
				const newHwm = await signSidecar<FinderHwmPayload>(
					HWM_STORE,
					{
						generation: nextGen,
						keystoreGeneration: keystore.keystoreGeneration,
						epoch: keystore.epoch,
						ts: Date.now()
					},
					keystore.hmacKeyRef
				);

				await withStores(db, ['skillbridge-finder', HWM_STORE], 'readwrite', (tx) => {
					// eslint-disable-next-line mtc/encrypted-store-registry -- THE sanctioned encryption-boundary write: ciphertext from encryptRecord, under withWriteLocks.
					tx.objectStore('skillbridge-finder').put({ id: 0, rec: blob });
					tx.objectStore(HWM_STORE).put({ id: 0, ...newHwm });
				});

				_generation = nextGen;
				wrote = true;
				// Residency guard: a relockSync() during this save must not be undone by re-populating decrypted state
				// (the IDB write already persisted the edit). No lockState update belongs here: the relocked check above
				// means a write only ever runs on a store load() already opened.
				if (relockEpoch === relockAtStart) _state = next;
			}
		);
		if (wrote) opts.onBroadcast?.({ type: 'skillbridge-finder-updated' });
	}

	const api = {
		/**
		 * Whether the record is loaded and writable. FALSE before the first load, after a relock, and after a read that
		 * failed, when the current record is UNKNOWN. Callers MUST gate on this and fail closed rather than read the
		 * empty defaults below as "the person saved nothing".
		 */
		get ready(): boolean {
			return _state !== null;
		},

		/** Whether the last load failed, so the saved finder record could not be read; a load that succeeds clears it. */
		get failed(): boolean {
			return _failed;
		},

		/**
		 * Whether the person's lock holds: only a load they ask for opens it, and page hygiene on top of it does not move
		 * it. While an Unlock is still reading it also holds, until that read lands.
		 */
		get locked(): boolean {
			return lockState === 'locked';
		},

		/** Reactive place and reach; EMPTY before load / when relocked - gate on `ready` first. */
		get setup(): FinderSetup {
			return _state?.finderSetup ?? {};
		},

		/** Reactive filters; EMPTY before load / when relocked. */
		get filters(): FinderFilters {
			return _state?.finderFilters ?? {};
		},

		/** The saved programs, oldest first; EMPTY before load / when relocked. */
		get saved(): FinderRecord['finderSaved'] {
			return _state?.finderSaved ?? [];
		},

		/** The ids picked to compare; EMPTY before load / when relocked. */
		get compare(): number[] {
			return _state?.finderCompare ?? [];
		},

		/**
		 * Re-read from disk. A relock landing WHILE this runs wins: repopulating decrypted state into a tab that has since
		 * locked silently undoes the lock, and the idle timer does not fire twice. Same residency guard persist() carries.
		 */
		async load(): Promise<void> {
			const relockAtStart = relockEpoch;
			let ks: KeystoreRow | undefined;
			// The person's Unlock is a new attempt: a page waits for it instead of repeating the last failure while it
			// runs. An automatic re-read keeps the failure, so a note that stays true is not taken down and put up again.
			if (lockState === 'locked') _failed = false;
			try {
				await withWriteLocks(
					async () => {
						ks = await readKeystoreRow(db);
						return ks.keystoreGeneration;
					},
					async () => {
						if (!ks) throw new KeystoreNotInitializedError();
						const keystore = ks;
						const gen = await readCurrentGeneration(keystore);
						// The generation moves only with the record it belongs to: a read that fails after a peer's save
						// would otherwise pair the newer generation with the older record, and a write from them would
						// pass the conflict check and lay it over the peer's save.
						if (gen === 0) {
							_generation = gen;
							if (relockEpoch === relockAtStart) {
								_state = EMPTY_RECORD();
								lockState = 'unlocked';
							}
							return;
						}
						const row = await getRow<StateRow>(db, 'skillbridge-finder');
						if (!row) throw new Error('E_FINDER_BODY_MISSING');
						const decoded = await decryptFinderRecord(row.rec, keystore, gen);
						_generation = gen;
						if (relockEpoch === relockAtStart) {
							_state = decoded;
							lockState = 'unlocked';
						}
					}
				);
			} catch (e) {
				// The stored record could not be read, so what is held is no longer known to be current. Say so (not
				// ready, empty defaults) rather than serve it. lockState stays as it was, so the next automatic re-read
				// still tries.
				_state = null;
				_failed = true;
				throw e;
			}
			_failed = false;
		},

		/**
		 * AUTOMATIC re-read: a peer tab's change, a page restore, recovery from a failed write. It DECRYPTS, so it
		 * answers to how the plaintext went away, not to whether it is gone.
		 *
		 * Refuses only a `locked` store - the person asked, or their presence lapsed, and re-reading would reverse that.
		 * An `evicted` store lost its plaintext to page hygiene on the way out and the page has come back, so the re-read
		 * is the undo it is owed. An unlocked store re-reads so a peer's change still lands.
		 *
		 * A hidden page does not decrypt on its own: nobody can see the result, and a page that goes hidden relocks and
		 * comes back through the lifecycle's visible restore, which calls this. load() is not gated - Unlock and start-up
		 * use it, and they are the person asking.
		 */
		refresh(): Promise<void> {
			if (lockState === 'locked' || document.visibilityState === 'hidden') {
				return Promise.resolve();
			}
			return api.load();
		},

		/** Replace the place and reach, or update it from the record as saved (so quick changes each build on the one before). */
		setSetup(next: FinderSetup | ((current: FinderSetup) => FinderSetup)): Promise<void> {
			return persist((base) => ({
				...base,
				finderSetup: typeof next === 'function' ? next(base.finderSetup ?? {}) : next
			}));
		},

		/** Replace the filters, or update them from the record as saved. */
		setFilters(next: FinderFilters | ((current: FinderFilters) => FinderFilters)): Promise<void> {
			return persist((base) => ({
				...base,
				finderFilters: typeof next === 'function' ? next(base.finderFilters ?? {}) : next
			}));
		},

		/** Keep a program whole. A program already saved stays as it was; a full list refuses a new one. */
		save(listing: Listing, savedOn: string): Promise<void> {
			return persist((base) => {
				if (base.finderSaved.some((item) => item.id === listing.i)) return base;
				if (base.finderSaved.length >= MAX_SAVED) throw new Error('E_FINDER_SAVED_FULL');
				return {
					...base,
					finderSaved: [...base.finderSaved, { id: listing.i, savedOn, facts: listing }]
				};
			});
		},

		unsave(id: number): Promise<void> {
			return persist((base) =>
				base.finderSaved.some((item) => item.id === id)
					? { ...base, finderSaved: base.finderSaved.filter((item) => item.id !== id) }
					: base
			);
		},

		/** Pick a program to compare. The cap is judged here, on the record as it stands, so a second tab cannot pass it. */
		addCompare(id: number): Promise<void> {
			return persist((base) => {
				if (base.finderCompare.includes(id)) return base;
				if (base.finderCompare.length >= MAX_COMPARE) throw new Error('E_FINDER_COMPARE_FULL');
				return { ...base, finderCompare: [...base.finderCompare, id] };
			});
		},

		removeCompare(id: number): Promise<void> {
			return persist((base) =>
				base.finderCompare.includes(id)
					? { ...base, finderCompare: base.finderCompare.filter((picked) => picked !== id) }
					: base
			);
		},

		clearCompare(): Promise<void> {
			return persist((base) =>
				base.finderCompare.length > 0 ? { ...base, finderCompare: [] } : base
			);
		},

		/** Sync relock for the pagehide/freeze handlers - drop the reference. */
		relockSync(reason: RelockReason): void {
			relockNow(reason);
		},

		/** Clear the finder record + its HWM (the keystore is owned by the profile wipe). */
		async wipe(): Promise<void> {
			await withStores(db, ['skillbridge-finder', HWM_STORE], 'readwrite', (tx) => {
				tx.objectStore('skillbridge-finder').clear();
				tx.objectStore(HWM_STORE).clear();
			});
			_generation = 0;
			relockNow('user');
		}
	};

	return api;
}

export type FinderStore = ReturnType<typeof createFinderStore>;
