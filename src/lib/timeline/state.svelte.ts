import type { TimelineState, TaskStatus, TimelineTaskState } from './types';
import { encodeTimelineState, decodeTimelineState } from './state-codec';
import { encryptRecord, decryptRecord, type RecordCtx } from '../crypto/record-crypto';
import { verifyRecordHmac, type KeystoreRecordV1 } from '../keystore/record';
import { signSidecar, verifySidecar, type SignedSidecar } from '../profile/sidecars';
import { nextLockState, type LockState, type RelockReason } from '../profile/lifecycle';
import {
	KeystoreNotInitializedError,
	KeystoreHmacMismatchError,
	OccConflictError
} from '../profile/store.svelte';
import { withWriteLocks } from '../db/locks';
import { withStores, reqToPromise } from '../db/schema';

/**
 * TimelineStateStore - orchestration over keystore + the generic record-crypto
 * boundary + IDB for the user's per-task state (done / skipped / snoozed / notes).
 * Mirrors the profile store's load/save/OCC/relock spine, but leaner: no clock, no
 * persona, and it NEVER mutates the keystore (timeline saves write only
 * `timeline-state` + its HWM, independent of profile saves; the AAD's
 * keystoreRecordHash excludes ivCounter, so binding stays stable). State lives in
 * the factory closure (`_state`); never exported.
 *
 * load() is fail-closed: verify the keystore-record HMAC, then the signed HWM,
 * BEFORE any decrypt. A missing `timeline-state-hwm` = "no timeline state yet"
 * (generation 0, empty) - legitimate for a returning user; the HWM is created on
 * first save. Relock drops the in-memory reference (note strings are immutable JS
 * strings; cannot be byte-zeroized - documented residual); the on-disk record stays
 * encrypted.
 *
 * Deviation: reuses `withWriteLocks` (profile-write exclusive) rather than a
 * dedicated `timeline-write` lock - safe full-serialization for a single-user app,
 * no change to shipped lock code. HWM domain-separation is via the sidecar `name`
 * ('timeline-state-hwm'), so no new HMAC prefix is needed.
 */

/** A write was attempted against unloaded/relocked state, where the current record is UNKNOWN. */
export class TimelineRelockedError extends Error {
	constructor() {
		super('E_TIMELINE_RELOCKED');
		this.name = 'TimelineRelockedError';
	}
}

const TIMELINE_CTX: RecordCtx = { storeName: 'timeline-state', recordId: 'self', schemaVersion: 1 };

/** Default returned before load / when relocked. Frozen so a consumer cannot mutate the shared default. */
const EMPTY_STATE: TimelineState = Object.freeze({ schemaVersion: 1, tasks: Object.freeze({}) });

type TimelineHwmPayload = {
	generation: number;
	keystoreGeneration: number;
	epoch: number;
	ts: number;
};

type KeystoreRow = KeystoreRecordV1 & { id: number };
type HwmRow = SignedSidecar<TimelineHwmPayload> & { id: number };
type StateRow = { id: number; rec: Uint8Array };

function getRow<T>(
	db: IDBDatabase,
	store: 'keystore' | 'timeline-state-hwm' | 'timeline-state'
): Promise<T | undefined> {
	return withStores(db, store, 'readonly', (tx) =>
		reqToPromise<T | undefined>(tx.objectStore(store).get(0))
	);
}

/** Drop undefined fields so an empty task entry can be pruned and JSON stays minimal. */
function cleanTaskState(s: TimelineTaskState): TimelineTaskState {
	const out: TimelineTaskState = {};
	if (s.status !== undefined) out.status = s.status;
	if (s.snoozeUntil !== undefined) out.snoozeUntil = s.snoozeUntil;
	if (s.notes !== undefined) out.notes = s.notes;
	return out;
}

export type TimelineBroadcastEvent = { type: 'timeline-updated' | 'relocked' };
export type TimelineStoreOptions = { onBroadcast?: (e: TimelineBroadcastEvent) => void };

export function createTimelineStateStore(db: IDBDatabase, opts: TimelineStoreOptions = {}) {
	let _state = $state<TimelineState | null>(null);
	let _generation = 0; // the loaded/written HWM generation, for auto-OCC
	let relockEpoch = 0;
	// How this store came to have no plaintext. `_state === null` says the record is not in memory,
	// never WHY - and the reasons demand opposite answers from a re-read. See refresh().
	let lockState: LockState = 'unlocked';

	function relockNow(reason: RelockReason): void {
		_state = null;
		relockEpoch++;
		lockState = nextLockState(lockState, reason);
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

	/** Current timeline generation (0 = no HWM yet = no timeline state written). */
	async function readCurrentGeneration(keystore: KeystoreRow): Promise<number> {
		const hwmRow = await getRow<HwmRow>(db, 'timeline-state-hwm');
		if (!hwmRow) return 0;
		const hwm = await verifySidecar<TimelineHwmPayload>(
			'timeline-state-hwm',
			{ v: 1, payload: hwmRow.payload, mac: hwmRow.mac },
			keystore.hmacKeyRef
		);
		return hwm.generation;
	}

	/**
	 * Apply `mutate` to the CURRENT record and persist the result. The merge runs INSIDE the write
	 * lock, after the OCC check, so a concurrent action cannot build on a base that a write which
	 * already landed has superseded (every task shares one self-row, so two quick status clicks
	 * would otherwise drop one). A null `_state` means "not loaded / relocked" - never "no tasks
	 * recorded" - and a write against it is refused: relock deliberately leaves `_generation`
	 * intact, so OCC cannot catch such a write, and it would silently persist an empty timeline
	 * over every status, snooze, and note the user has saved.
	 */
	async function persist(mutate: (base: TimelineState) => TimelineState): Promise<void> {
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
				if (_state === null) throw new TimelineRelockedError();

				const next = mutate(_state);
				const nextGen = currentGen + 1;
				const blob = await encryptRecord(
					TIMELINE_CTX,
					new Uint8Array(encodeTimelineState(next)),
					keystore,
					nextGen
				);
				const newHwm = await signSidecar(
					'timeline-state-hwm',
					{
						generation: nextGen,
						keystoreGeneration: keystore.keystoreGeneration,
						epoch: keystore.epoch,
						ts: Date.now()
					},
					keystore.hmacKeyRef
				);

				await withStores(db, ['timeline-state', 'timeline-state-hwm'], 'readwrite', (tx) => {
					// eslint-disable-next-line mtc/encrypted-store-registry -- THE sanctioned encryption-boundary write: ciphertext from encryptRecord, under withWriteLocks.
					tx.objectStore('timeline-state').put({ id: 0, rec: blob });
					tx.objectStore('timeline-state-hwm').put({ id: 0, ...newHwm });
				});

				_generation = nextGen;
				// Residency guard: a relockSync() during this save must not be undone by
				// re-populating decrypted state (the IDB write already persisted the edit).
				if (relockEpoch === relockAtStart) _state = next;
			}
		);
		opts.onBroadcast?.({ type: 'timeline-updated' });
	}

	function update(taskId: string, patch: Partial<TimelineTaskState>): Promise<void> {
		return persist((base) => {
			const merged = cleanTaskState({ ...base.tasks[taskId], ...patch });
			const nextTasks: Record<string, TimelineTaskState> = {};
			for (const [id, st] of Object.entries(base.tasks)) {
				if (id !== taskId) nextTasks[id] = st;
			}
			if (Object.keys(merged).length > 0) nextTasks[taskId] = merged;
			return { schemaVersion: 1, tasks: nextTasks };
		});
	}

	const api = {
		/** Reactive timeline state; EMPTY before load / when relocked. */
		get state(): TimelineState {
			return _state ?? EMPTY_STATE;
		},

		/**
		 * Re-read from disk. A relock landing WHILE this runs wins: repopulating decrypted state into
		 * a tab that has since locked silently undoes the lock, and the idle timer does not fire twice.
		 * Same residency guard persist() carries.
		 */
		async load(): Promise<void> {
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
					const gen = await readCurrentGeneration(keystore);
					_generation = gen;
					if (gen === 0) {
						if (relockEpoch === relockAtStart) {
							_state = { schemaVersion: 1, tasks: {} };
							lockState = 'unlocked';
						}
						return;
					}
					const row = await getRow<StateRow>(db, 'timeline-state');
					if (!row) throw new Error('E_TIMELINE_BODY_MISSING');
					const decoded = decodeTimelineState(
						await decryptRecord(TIMELINE_CTX, row.rec, keystore, gen)
					);
					if (relockEpoch === relockAtStart) {
						_state = decoded;
						lockState = 'unlocked';
					}
				}
			);
		},

		/**
		 * AUTOMATIC re-read: a peer tab's change, a page restore, recovery from a failed write. It
		 * DECRYPTS, so it answers to how the plaintext went away, not to whether it is gone.
		 *
		 * Refuses only a `locked` store - putting the user's task notes back in memory, and on
		 * screen, in a tab that locked itself is precisely what it must not do. An `evicted` store
		 * lost its plaintext to page hygiene on the way out and the page has come back, so the
		 * re-read is the undo it is owed. An unlocked store re-reads so a peer's change still lands.
		 */
		refresh(): Promise<void> {
			if (lockState === 'locked') return Promise.resolve();
			return api.load();
		},

		/** Set or clear a task status (clearing also drops any snooze). */
		setStatus(taskId: string, status: TaskStatus | undefined): Promise<void> {
			return update(taskId, { status, snoozeUntil: undefined });
		},

		/** Snooze a task until an ISO date (sets status 'snoozed'). */
		setSnooze(taskId: string, untilIso: string): Promise<void> {
			return update(taskId, { status: 'snoozed', snoozeUntil: untilIso });
		},

		/** Set or clear a free-text note (empty string clears it). */
		setNote(taskId: string, note: string | undefined): Promise<void> {
			return update(taskId, { notes: note ? note : undefined });
		},

		/** Sync relock for the pagehide/freeze handlers (wired at app-init) - drop the reference. */
		relockSync(reason: RelockReason): void {
			relockNow(reason);
		},

		/** Clear the timeline-state + HWM (the keystore is owned by the profile wipe). */
		async wipe(): Promise<void> {
			await withStores(db, ['timeline-state', 'timeline-state-hwm'], 'readwrite', (tx) => {
				tx.objectStore('timeline-state').clear();
				tx.objectStore('timeline-state-hwm').clear();
			});
			_generation = 0;
			relockNow('user');
		}
	};

	return api;
}

export type TimelineStateStore = ReturnType<typeof createTimelineStateStore>;
