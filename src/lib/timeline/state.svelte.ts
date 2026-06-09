import type { TimelineState, TaskStatus, TimelineTaskState } from './types';
import { encodeTimelineState, decodeTimelineState } from './state-codec';
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
 * Source: Timeline Engine design spec (2026-06-03) sections 3 + 6; plan A4.
 * Deviation (plan A4): reuses `withWriteLocks` (profile-write exclusive) rather than a
 * dedicated `timeline-write` lock - safe full-serialization for a single-user app,
 * no change to shipped lock code. HWM domain-separation is via the sidecar `name`
 * ('timeline-state-hwm'), so no new HMAC prefix is needed.
 */

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

	async function persist(next: TimelineState): Promise<void> {
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

	async function update(taskId: string, patch: Partial<TimelineTaskState>): Promise<void> {
		const cur = _state ?? { schemaVersion: 1 as const, tasks: {} };
		const merged = cleanTaskState({ ...cur.tasks[taskId], ...patch });
		const nextTasks: Record<string, TimelineTaskState> = {};
		for (const [id, st] of Object.entries(cur.tasks)) {
			if (id !== taskId) nextTasks[id] = st;
		}
		if (Object.keys(merged).length > 0) nextTasks[taskId] = merged;
		await persist({ schemaVersion: 1, tasks: nextTasks });
	}

	const api = {
		/** Reactive timeline state; EMPTY before load / when relocked. */
		get state(): TimelineState {
			return _state ?? EMPTY_STATE;
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
						_state = { schemaVersion: 1, tasks: {} };
						return;
					}
					const row = await getRow<StateRow>(db, 'timeline-state');
					if (!row) throw new Error('E_TIMELINE_BODY_MISSING');
					_state = decodeTimelineState(await decryptRecord(TIMELINE_CTX, row.rec, keystore, gen));
				}
			);
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
		relockSync(): void {
			relockNow();
		},

		/** Clear the timeline-state + HWM (the keystore is owned by the profile wipe). */
		async wipe(): Promise<void> {
			await withStores(db, ['timeline-state', 'timeline-state-hwm'], 'readwrite', (tx) => {
				tx.objectStore('timeline-state').clear();
				tx.objectStore('timeline-state-hwm').clear();
			});
			_generation = 0;
			relockNow();
		}
	};

	return api;
}

export type TimelineStateStore = ReturnType<typeof createTimelineStateStore>;
