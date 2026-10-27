import { encryptCalendarRecord } from '../calendar/crypto-boundary';
import { LOCK_TIMEOUT_MS, RunAbortedError, rotateOrUpgrade } from '../db/locks';
import { reqToPromise, STORES, withStores, type StoreName } from '../db/schema';
import {
	composeRestore,
	type RestoreGens,
	type RestoreOptions,
	type RestoreResult
} from '../backup/restore-writer';
import type { ValidInner } from '../backup/validate';
import { encryptProfileRecord } from '../profile/crypto-boundary';
import { zeroizeRecord } from '../profile/lifecycle';
import { signSidecar } from '../profile/sidecars';
import type { ProfileV1 } from '../profile/types';
import { encryptFinderRecord } from '../skillbridge-finder/state/crypto-boundary';
import { encryptTimelineRecord } from '../timeline/crypto-boundary';
import { readCounterIn, writeCounterIn } from './app-lock-store';
import { bumpIvCounter } from './iv-counter';
import { KeystoreNotInitializedError, type KeystoreRow } from './read';
import { keyIdentity, signKeystore, type KeystoreRecordV1 } from './record';

/**
 * The restore onto a device that is locked behind a forgotten PIN. No key can be had, so nothing on the device is read
 * through a key: the device is replaced whole. Under the exclusive keystore lock, in ONE transaction, every store is
 * emptied and a fresh local keystore, the four records and their markers are written, so the PIN ends off and the app
 * opens with the backup's data. Either all of it is written or none of it is.
 *
 * What this cannot carry over, and says so: the API key (it is sealed under keys nobody can open), the calendar's list of
 * events handed to this phone (same reason), and the downloaded finder files and the wrong tries (cleared with the rest).
 *
 * The values read without a key (the four generations and the newest write time) are plaintext rows anyone with the phone
 * could have written, and no key can check them. They are used for two things only: to set the restored generations one
 * step past them, which a stale tab must see as a change, and to keep the clock mark from going back. A forged number
 * can make a generation or the mark larger than it should be; it cannot read or write anything.
 */

export type LockedDevice = { gens: RestoreGens; installUuid: Uint8Array; lastTs: number | null };

const MARKERS = [
	'profile-hwm',
	'timeline-state-hwm',
	'calendar-sync-hwm',
	'skillbridge-finder-hwm'
] as const;

type Put = { store: StoreName; value: unknown };

const fail = (code: Extract<RestoreResult, { ok: false }>['code']): RestoreResult => ({
	ok: false,
	code
});

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, i) => byte === b[i]);

/** A generation in a plaintext marker: a whole number with room to add one, else read as 0 (never saved). */
function generationOf(payload: Record<string, unknown>): number {
	const value = payload.generation;
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 2 ** 52
		? value
		: 0;
}

function markerOf(row: unknown): { generation: number; ts: number | null } {
	const payload = (row as { payload?: unknown } | undefined)?.payload;
	if (typeof payload !== 'object' || payload === null) return { generation: 0, ts: null };
	const record = payload as Record<string, unknown>;
	const ts = record.ts;
	return {
		generation: generationOf(record),
		ts: typeof ts === 'number' && Number.isFinite(ts) && ts >= 0 ? ts : null
	};
}

/** The PIN row and the plaintext marks, read in one transaction so they were true at one moment. */
async function readPinDevice(
	db: IDBDatabase
): Promise<{ device: LockedDevice; row: Extract<KeystoreRow, { mode: 'pin' }> }> {
	const [row, profile, timeline, calendar, finder] = await withStores(
		db,
		['keystore', ...MARKERS],
		'readonly',
		(tx) => {
			const get = <T>(store: StoreName) =>
				reqToPromise<T | undefined>(tx.objectStore(store).get(0));
			return Promise.all([
				get<KeystoreRow>('keystore'),
				get<unknown>('profile-hwm'),
				get<unknown>('timeline-state-hwm'),
				get<unknown>('calendar-sync-hwm'),
				get<unknown>('skillbridge-finder-hwm')
			]);
		}
	);
	// A device that is not behind a PIN has nothing to be restored from here; the flow reads this as "the device changed".
	if (!row || row.mode !== 'pin') throw new KeystoreNotInitializedError();
	const marks = [profile, timeline, calendar, finder].map(markerOf);
	const times = marks.flatMap((mark) => (mark.ts === null ? [] : [mark.ts]));
	return {
		row,
		device: {
			gens: {
				profile: marks[0]?.generation ?? 0,
				timeline: marks[1]?.generation ?? 0,
				calendar: marks[2]?.generation ?? 0,
				finder: marks[3]?.generation ?? 0
			},
			installUuid: new Uint8Array(row.installUuid),
			lastTs: times.length === 0 ? null : Math.max(...times)
		}
	};
}

/**
 * What a locked device shows without a key: its install and the generations its markers claim. Unauthenticated (see the
 * top of this file). Throws KeystoreNotInitializedError unless the keystore row is in PIN mode.
 */
export async function readLockedDevice(db: IDBDatabase): Promise<LockedDevice> {
	return (await readPinDevice(db)).device;
}

/**
 * ONE readwrite transaction with strict durability, so the writes reach disk before it reports done. Resolves after the
 * commit. A throw from `fn` (or from any request) aborts it, and an aborted transaction leaves every store as it was.
 */
function commit(db: IDBDatabase, fn: (tx: IDBTransaction) => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const tx = db.transaction([...STORES], 'readwrite', { durability: 'strict' });
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('E_WRITE_FAILED'));
		tx.onabort = () => reject(tx.error ?? new Error('E_WRITE_FAILED'));
		fn(tx).catch((err: unknown) => {
			try {
				tx.abort();
			} catch {
				// The transaction is already finished or aborting.
			}
			reject(err);
		});
	});
}

/**
 * Replace everything on a PIN-locked device with `inner`, as a local device with fresh keys.
 *
 * Returns the new generations, or the code of the one thing that stopped it. A run that was cancelled throws
 * RunAbortedError itself (nothing was written). A lock timeout and a transaction that failed both report as
 * E_WRITE_FAILED: the write is one transaction, so a failure means nothing was written. `afterPut` is called after each
 * step of the transaction, counting from 0: one clear per store, the lock counter, then the nine rows.
 */
export async function restoreLockedDevice(
	db: IDBDatabase,
	inner: ValidInner,
	expected: { gens: RestoreGens; installUuid: Uint8Array },
	opts: RestoreOptions & { afterPut?: (index: number, store: StoreName) => void }
): Promise<RestoreResult> {
	try {
		return await rotateOrUpgrade(
			() => replaceLockedDevice(db, inner, expected, opts),
			LOCK_TIMEOUT_MS,
			opts.signal
		);
	} catch (e) {
		if (e instanceof RunAbortedError) throw e;
		return fail('E_WRITE_FAILED');
	}
}

async function replaceLockedDevice(
	db: IDBDatabase,
	inner: ValidInner,
	expected: { gens: RestoreGens; installUuid: Uint8Array },
	opts: RestoreOptions & { afterPut?: (index: number, store: StoreName) => void }
): Promise<RestoreResult> {
	// Everything that holds the person's data in memory and is not the database's own copy, wiped on every way out.
	const staged: Uint8Array[] = [];
	const records: ProfileV1[] = [];
	try {
		// 1. Still the device the person confirmed against, read again under the lock.
		let found: Awaited<ReturnType<typeof readPinDevice>>;
		try {
			found = await readPinDevice(db);
		} catch (e) {
			if (e instanceof KeystoreNotInitializedError) return fail('E_RESTORE_DEVICE_CHANGED');
			throw e;
		}
		const { device, row } = found;
		if (!sameBytes(device.installUuid, expected.installUuid)) {
			return fail('E_RESTORE_DEVICE_CHANGED');
		}
		if (
			device.gens.profile !== expected.gens.profile ||
			device.gens.timeline !== expected.gens.timeline ||
			device.gens.calendar !== expected.gens.calendar ||
			device.gens.finder !== expected.gens.finder
		) {
			return fail('E_RESTORE_DEVICE_MOVED');
		}

		// 2. The same composer as every restore. The calendar's handed-over list cannot be read without the key.
		const at = (opts.now ?? Date.now)();
		const { gens, profile, timeline, calendar, finder } = composeRestore(
			inner,
			{ gens: device.gens, lastSeenAt: null, tsProfile: device.lastTs, lastAdd: undefined },
			at,
			{ staged, records }
		);

		// 3. A fresh local keystore, made the way the first run makes one: keys that cannot be read out, a new install.
		const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
			'encrypt',
			'decrypt'
		]);
		const hmacKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
			'sign',
			'verify'
		]);
		const unsigned: KeystoreRecordV1 & { id: number } = {
			id: 0,
			v: 1,
			mode: 'local',
			// One past the PIN row, so nothing sealed or signed for it fits the new row.
			keystoreGeneration: row.keystoreGeneration + 1,
			epoch: row.epoch + 1,
			ivCounter: bumpIvCounter(0).newValue,
			installUuid: crypto.getRandomValues(new Uint8Array(16)),
			dataKeyRef: dataKey,
			hmacKeyRef: hmacKey
		};
		// A local row is signed by its own HMAC key, which is what reading it back hands out as the signing key.
		const next = {
			...unsigned,
			recordHmac: await signKeystore(unsigned, { bootstrapMacKey: hmacKey })
		};

		// 4. Encrypt through each store's own boundary under the new identity and sign the markers. Every await ends
		// here: the transaction below opens straight after.
		const identity = keyIdentity(next);
		const profileBlob = await encryptProfileRecord(profile, identity, dataKey);
		const timelineBlob = await encryptTimelineRecord(timeline, identity, dataKey, gens.timeline);
		const calendarBlob = await encryptCalendarRecord(calendar, identity, dataKey, gens.calendar);
		const finderBlob = await encryptFinderRecord(finder, identity, dataKey, gens.finder);
		staged.push(profileBlob, timelineBlob, calendarBlob, finderBlob);
		const sign = (name: (typeof MARKERS)[number], generation: number) =>
			signSidecar(
				name,
				{
					generation,
					keystoreGeneration: next.keystoreGeneration,
					epoch: next.epoch,
					ts: at
				},
				hmacKey
			).then((signed) => ({ id: 0, ...signed }));
		const [profileMark, timelineMark, calendarMark, finderMark] = await Promise.all([
			sign('profile-hwm', gens.profile),
			sign('timeline-state-hwm', gens.timeline),
			sign('calendar-sync-hwm', gens.calendar),
			sign('skillbridge-finder-hwm', gens.finder)
		]);
		// Listed by store name, as the PIN rotation lists its rows: each value is ciphertext from its own boundary above.
		const puts: Put[] = [
			{ store: 'keystore', value: next },
			{ store: 'profile', value: { id: 0, rec: profileBlob } },
			{ store: 'profile-hwm', value: profileMark },
			{ store: 'timeline-state', value: { id: 0, rec: timelineBlob } },
			{ store: 'timeline-state-hwm', value: timelineMark },
			{ store: 'calendar-sync', value: { id: 0, rec: calendarBlob } },
			{ store: 'calendar-sync-hwm', value: calendarMark },
			{ store: 'skillbridge-finder', value: { id: 0, rec: finderBlob } },
			{ store: 'skillbridge-finder-hwm', value: finderMark }
		];

		// 5. The check and the writes. The check is the transaction's first statement, so nothing can abort or change the
		// run between it and the first write. The lock counter goes back as the old value plus one: a tab that noted it
		// before must read a different one after.
		await commit(db, async (tx) => {
			if (opts.signal.aborted || !opts.mayCommit()) throw new RunAbortedError();
			opts.onCommitting();
			let written = 0;
			const counter = await readCounterIn(tx);
			for (const store of STORES) {
				tx.objectStore(store).clear();
				opts.afterPut?.(written++, store);
			}
			writeCounterIn(tx, counter + 1);
			opts.afterPut?.(written++, 'app-lock');
			for (const put of puts) {
				tx.objectStore(put.store).put(put.value);
				opts.afterPut?.(written++, put.store);
			}
		});
		return { ok: true, gens };
	} catch (e) {
		// A cancelled run reports as the cancel, whatever else failed on its way out.
		if (e instanceof RunAbortedError || opts.signal.aborted) throw new RunAbortedError();
		return fail('E_WRITE_FAILED');
	} finally {
		for (const bytes of staged) bytes.fill(0);
		for (const record of records) zeroizeRecord(record);
	}
}
