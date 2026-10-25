import { decodeCalendarSyncState, encodeCalendarSyncState } from '../calendar/codec';
import { decryptCalendarRecord, encryptCalendarRecord } from '../calendar/crypto-boundary';
import type { CalendarSyncState, HandedOverEvent } from '../calendar/types';
import { LOCK_TIMEOUT_MS, RunAbortedError, rotateOrUpgrade } from '../db/locks';
import { withStores, type StoreName } from '../db/schema';
import { bumpIvCounter } from '../keystore/iv-counter';
import { keyIdentity, signKeystore, type KeyIdentity } from '../keystore/record';
import {
	KeystoreHmacMismatchError,
	KeystoreNotInitializedError,
	readKeystoreRow
} from '../keystore/read';
import { safeLog } from '../log/safelog';
import { updateLastSeen } from '../profile/clock';
import { decodeProfile, encodeProfile } from '../profile/codec';
import { encryptProfileRecord } from '../profile/crypto-boundary';
import { readDeviceState } from '../profile/device-state';
import { zeroizeRecord } from '../profile/lifecycle';
import { signSidecar } from '../profile/sidecars';
import { getRow } from '../profile/store.svelte';
import type { ProfileV1 } from '../profile/types';
import { decodeFinderRecord, encodeFinderRecord } from '../skillbridge-finder/state/codec';
import { encryptFinderRecord } from '../skillbridge-finder/state/crypto-boundary';
import type { FinderRecord } from '../skillbridge-finder/state/types';
import { decodeTimelineState, encodeTimelineState } from '../timeline/state-codec';
import { encryptTimelineRecord } from '../timeline/crypto-boundary';
import type { TimelineState } from '../timeline/types';
import type { ValidInner } from './validate';

/**
 * The one path that replaces a person's saved data with a backup. Everything happens in ONE database step: either the
 * profile, timeline, calendar and finder hold the backup's content afterwards, re-encrypted for this device so the app
 * opens normally after a reload, or nothing changed at all. The device keeps its own bookkeeping: its install and keys
 * (so the stored API key still opens), its clock mark, and the calendar's list of events it handed to this phone.
 *
 * A file made before the finder existed holds no finder record, and restoring it writes an empty one: the device then
 * holds the person's data as that backup had it, not a finder saved since. Either way the finder's record is signed
 * with a fresh marker one step past this device, like the other stores, so its generation never comes round again.
 *
 * The file's content is all that is taken from it. Its generations, clock mark, sidecars and keystore never reach the
 * device: this device's own counters decide what the new generations are, which is what makes a reload accept the
 * result and a stale second tab fail its next save.
 *
 * Inside the exclusive keystore lock only raw readers run (no store's load or save, which take the same lock and
 * would wait on it forever). Every await ends before the write transaction opens; its first statement is the commit
 * check, and the writes follow it in the same synchronous block, so nothing can abort or change the run between the
 * check and the writes.
 *
 * After that step has committed, and still under the lock (so no download can land a row meanwhile), the finder's
 * cached listings and opened ids are cleared in a step of their own: they are public data kept for this device alone,
 * never part of a backup, and would otherwise show against data they were not cached for. They are never read. A
 * failure there is logged and does not undo the restore, since the cache downloads again.
 */

export type RestoreGens = { profile: number; timeline: number; calendar: number; finder: number };

/** What the confirm was built from: the generations the person read and the install they read them on. */
export type RestoreExpected = { gens: RestoreGens; installUuid: Uint8Array };

export type RestoreOptions = {
	/** The run's signal. An abort withdraws a request still queued and stops the write before it starts. */
	signal: AbortSignal;
	/** Whether the session still allows the write; read once, synchronously, as the transaction's first statement. */
	mayCommit: () => boolean;
	/** Called in the same synchronous block, once the check has passed and before the first write. */
	onCommitting: () => void;
	now?: () => number;
};

export type RestoreFailureCode =
	| 'E_RESTORE_DEVICE_MOVED'
	| 'E_RESTORE_DEVICE_CHANGED'
	| 'E_RESTORE_DEVICE_DAMAGED'
	| 'E_WRITE_FAILED';

export type RestoreResult =
	{ ok: true; gens: RestoreGens } | { ok: false; code: RestoreFailureCode };

/** The nine stores a restore writes. The person's own API key (byok) is never among them. */
const WRITTEN_STORES: StoreName[] = [
	'profile',
	'profile-hwm',
	'keystore',
	'timeline-state',
	'timeline-state-hwm',
	'calendar-sync',
	'calendar-sync-hwm',
	'skillbridge-finder',
	'skillbridge-finder-hwm'
];

const FINDER_PACK_STORE: StoreName = 'skillbridge-finder-pack';

// What a restore replaces with when the file holds no record for a store: the same record a fresh store starts from.
const emptyTimeline = (): TimelineState => ({ schemaVersion: 1, tasks: {} });
const emptyCalendar = (): CalendarSyncState => ({
	schemaVersion: 1,
	exclusions: { taskIds: [], categories: [] }
});
const emptyFinder = (): FinderRecord => ({ schemaVersion: 1, finderSaved: [], finderCompare: [] });

// The backup mark, which the device composes itself; the file never carries it.
const MARK_FIELDS = [
	'lastBackupAt',
	'backupGenProfile',
	'backupGenTimeline',
	'backupGenCalendar',
	'backupGenFinder'
] as const;

const fail = (code: RestoreFailureCode): RestoreResult => ({ ok: false, code });

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Two records hold the same data: arrays and objects compared by content, bytes by value, absent equal to undefined. */
function sameRecord(a: unknown, b: unknown): boolean {
	if (a instanceof Uint8Array || b instanceof Uint8Array) {
		return a instanceof Uint8Array && b instanceof Uint8Array && sameBytes(a, b);
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item: unknown, i) => sameRecord(item, b[i]))
		);
	}
	if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
		const left = Object.entries(a).filter(([, value]) => value !== undefined);
		const right = Object.entries(b).filter(([, value]) => value !== undefined);
		return (
			left.length === right.length &&
			left.every(([key, value]) => sameRecord(value, (b as Record<string, unknown>)[key]))
		);
	}
	return a === b;
}

/** JSON text with every object's keys in sorted order, so two equal records give equal text. */
function sortedJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		typeof v === 'object' && v !== null && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
			: v
	);
}

/**
 * Restore `inner` onto this device.
 *
 * Returns the new generations, or the code of the one thing that stopped it. A run that was cancelled throws
 * RunAbortedError itself (nothing was written). A lock timeout and a transaction that failed both report as
 * E_WRITE_FAILED: the write is one transaction, so a failure means nothing was written.
 */
export async function restoreBackup(
	db: IDBDatabase,
	inner: ValidInner,
	expected: RestoreExpected,
	opts: RestoreOptions
): Promise<RestoreResult> {
	try {
		return await rotateOrUpgrade(
			() => replaceStores(db, inner, expected, opts),
			LOCK_TIMEOUT_MS,
			opts.signal
		);
	} catch (e) {
		if (e instanceof RunAbortedError) throw e;
		return fail('E_WRITE_FAILED');
	}
}

async function replaceStores(
	db: IDBDatabase,
	inner: ValidInner,
	expected: RestoreExpected,
	opts: RestoreOptions
): Promise<RestoreResult> {
	// Everything that holds the person's data in memory and is not the database's own copy, wiped on every way out.
	const staged: Uint8Array[] = [];
	const records: ProfileV1[] = [];
	try {
		// 1. The install is the one the person confirmed against. A missing keystore is another tab's erase.
		let verified: Awaited<ReturnType<typeof readKeystoreRow>>;
		try {
			verified = await readKeystoreRow(db);
		} catch (e) {
			if (e instanceof KeystoreNotInitializedError) return fail('E_RESTORE_DEVICE_CHANGED');
			if (e instanceof KeystoreHmacMismatchError) return fail('E_RESTORE_DEVICE_DAMAGED');
			throw e;
		}
		const { row: keystore, keys } = verified;
		if (!sameBytes(keystore.installUuid, expected.installUuid)) {
			return fail('E_RESTORE_DEVICE_CHANGED');
		}

		// 2. One verified snapshot of the device, read under the lock so nothing can move it before the write.
		let state: Awaited<ReturnType<typeof readDeviceState>>;
		try {
			state = await readDeviceState(db);
		} catch (e) {
			if (e instanceof KeystoreNotInitializedError) return fail('E_RESTORE_DEVICE_CHANGED');
			if (e instanceof Error && e.message === 'E_RESTORE_DEVICE_DAMAGED') {
				return fail('E_RESTORE_DEVICE_DAMAGED');
			}
			throw e;
		}
		// Setup always signs a profile mark, so none at all is damage, and the app treats it so on every load. Replacing
		// the data around it would hand a second tab the chance to save over the restore.
		if (state.ts.profile === null) return fail('E_RESTORE_DEVICE_DAMAGED');
		if (
			state.gens.profile !== expected.gens.profile ||
			state.gens.timeline !== expected.gens.timeline ||
			state.gens.calendar !== expected.gens.calendar ||
			state.gens.finder !== expected.gens.finder
		) {
			return fail('E_RESTORE_DEVICE_MOVED');
		}

		// 3. Each store moves one step past where this device is, so a peer's next save sees the change. The finder does
		// too when the file holds no finder record: it is then written empty, never cleared. A cleared finder would start
		// again at generation 0, and later saves would climb back to the number a stale tab holds, which would then pass
		// its conflict check and write its old record over the newer one.
		const gens: RestoreGens = {
			profile: state.gens.profile + 1,
			timeline: state.gens.timeline + 1,
			calendar: state.gens.calendar + 1,
			finder: state.gens.finder + 1
		};
		const at = (opts.now ?? Date.now)();

		// 4. Compose what the device will hold.
		const wire = new TextEncoder().encode(JSON.stringify(inner.stores.profile));
		staged.push(wire);
		const fromFile = decodeProfile(wire);
		records.push(fromFile);
		const profile: ProfileV1 = {
			...fromFile,
			schemaVersion: 1,
			generation: gens.profile,
			// The clock mark only ever moves forward on this device, whatever the file says.
			lastSeenAt: updateLastSeen(Math.max(state.lastSeenAt ?? 0, state.ts.profile ?? 0), at),
			// A file dated ahead of this clock is marked as made now, so the mark never claims a future backup.
			lastBackupAt: Math.min(inner.createdAt, at),
			backupGenProfile: gens.profile,
			backupGenTimeline: gens.timeline,
			backupGenCalendar: gens.calendar,
			backupGenFinder: gens.finder
		};
		records.push(profile);

		const timeline: TimelineState = structuredClone(
			inner.stores['timeline-state'] ?? emptyTimeline()
		);

		const calendar: CalendarSyncState = structuredClone(
			inner.stores['calendar-sync'] ?? emptyCalendar()
		);
		// The events handed to THIS phone's calendar belong to this device. If they cannot be read the record is being
		// replaced anyway; only the reminders to delete those events are lost.
		const handedOver = await readDeviceLastAdd(
			db,
			keyIdentity(keystore),
			keys.dataKey,
			state.gens.calendar
		);
		if (handedOver !== undefined) calendar.lastAdd = handedOver;

		const finder: FinderRecord = structuredClone(
			inner.stores['skillbridge-finder'] ?? emptyFinder()
		);

		// The writer's own check of itself, before anything is encrypted: the codecs give back exactly what is about to
		// be written, and that holds exactly the file's content and nothing else.
		verifyComposed(inner, profile, timeline, calendar, finder, records, staged);

		// 5. One counter bump for the whole restore, and the key record signed again over it. Install, keys, epoch and
		// generation stay as they are, so the stored API key still opens.
		const nextKeystore = { ...keystore, ivCounter: bumpIvCounter(keystore.ivCounter).newValue };
		nextKeystore.recordHmac = await signKeystore(nextKeystore, keys);

		// 6. Encrypt through each store's own boundary and sign the sidecars. Every await ends here: the transaction below opens straight after.
		const identity = keyIdentity(nextKeystore);
		const profileBlob = await encryptProfileRecord(profile, identity, keys.dataKey);
		const timelineBlob = await encryptTimelineRecord(
			timeline,
			identity,
			keys.dataKey,
			gens.timeline
		);
		const calendarBlob = await encryptCalendarRecord(
			calendar,
			identity,
			keys.dataKey,
			gens.calendar
		);
		const finderBlob = await encryptFinderRecord(finder, identity, keys.dataKey, gens.finder);
		staged.push(profileBlob, timelineBlob, calendarBlob, finderBlob);
		const sign = (name: string, generation: number) =>
			signSidecar(
				name,
				{
					generation,
					keystoreGeneration: keystore.keystoreGeneration,
					epoch: keystore.epoch,
					ts: at
				},
				keys.hmacKey
			);
		const [profileMark, timelineMark, calendarMark, finderMark] = await Promise.all([
			sign('profile-hwm', gens.profile),
			sign('timeline-state-hwm', gens.timeline),
			sign('calendar-sync-hwm', gens.calendar),
			sign('skillbridge-finder-hwm', gens.finder)
		]);

		// 7-8. The check and the writes, one transaction, one synchronous block. A throw before the first put aborts the
		// transaction with nothing written; a throw on any put does the same. The finder is first, so a failure on any
		// later put shows the whole transaction takes it back with the rest.
		await withStores(db, WRITTEN_STORES, 'readwrite', (tx) => {
			if (opts.signal.aborted || !opts.mayCommit()) throw new RunAbortedError();
			opts.onCommitting();
			// eslint-disable-next-line mtc/encrypted-store-registry -- the backup restore writer: ciphertext from encryptFinderRecord, one transaction with the other stores, under the exclusive keystore lock.
			tx.objectStore('skillbridge-finder').put({ id: 0, rec: finderBlob });
			tx.objectStore('skillbridge-finder-hwm').put({ id: 0, ...finderMark });
			// eslint-disable-next-line mtc/encrypted-store-registry -- the backup restore writer: ciphertext from encryptProfileRecord, one transaction with the other stores, under the exclusive keystore lock.
			tx.objectStore('profile').put({ id: 0, rec: profileBlob });
			tx.objectStore('profile-hwm').put({ id: 0, ...profileMark });
			tx.objectStore('keystore').put(nextKeystore);
			// eslint-disable-next-line mtc/encrypted-store-registry -- the backup restore writer: ciphertext from encryptTimelineRecord, one transaction with the other stores, under the exclusive keystore lock.
			tx.objectStore('timeline-state').put({ id: 0, rec: timelineBlob });
			tx.objectStore('timeline-state-hwm').put({ id: 0, ...timelineMark });
			// eslint-disable-next-line mtc/encrypted-store-registry -- the backup restore writer: ciphertext from encryptCalendarRecord, one transaction with the other stores, under the exclusive keystore lock.
			tx.objectStore('calendar-sync').put({ id: 0, rec: calendarBlob });
			tx.objectStore('calendar-sync-hwm').put({ id: 0, ...calendarMark });
		});
		await dropFinderPack(db);
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

/**
 * Clears every row of the finder's cache in a transaction of its own. The rows are never read, and a failure is logged
 * and swallowed: the restore has already replaced the data, and the cache is public files that download again.
 */
async function dropFinderPack(db: IDBDatabase): Promise<void> {
	try {
		await withStores(db, FINDER_PACK_STORE, 'readwrite', (tx) => {
			tx.objectStore(FINDER_PACK_STORE).clear();
		});
	} catch {
		safeLog({ code: 'E_INTERNAL' });
	}
}

/** The calendar's "events you added" list as this device holds it, or undefined when there is none or it cannot be read. */
async function readDeviceLastAdd(
	db: IDBDatabase,
	identity: KeyIdentity,
	dataKey: CryptoKey,
	generation: number
): Promise<HandedOverEvent[] | undefined> {
	if (generation < 1) return undefined;
	try {
		const row = await getRow<{ id: number; rec: Uint8Array }>(db, 'calendar-sync');
		if (!row) return undefined;
		return (await decryptCalendarRecord(row.rec, identity, dataKey, generation)).lastAdd;
	} catch {
		return undefined;
	}
}

/**
 * Before any write: decoding what the encoders will produce gives the composed record back, and the composed record
 * holds the file's content and nothing else (apart from the fields this device composes itself). A mismatch means the
 * writer or a codec has a bug; it throws, and nothing has been written.
 */
function verifyComposed(
	inner: ValidInner,
	profile: ProfileV1,
	timeline: TimelineState,
	calendar: CalendarSyncState,
	finder: FinderRecord,
	records: ProfileV1[],
	staged: Uint8Array[]
): void {
	const profileBytes = encodeProfile(profile);
	staged.push(profileBytes);
	const decodedProfile = decodeProfile(profileBytes);
	records.push(decodedProfile);
	// Held in variables so they are wiped with the rest: they hold every note and setting as text.
	const timelineBytes = encodeTimelineState(timeline);
	const calendarBytes = encodeCalendarSyncState(calendar);
	staged.push(timelineBytes, calendarBytes);
	// The finder's saved programs are held as text too, so its bytes are wiped with the rest.
	const finderBytes = encodeFinderRecord(finder);
	staged.push(finderBytes);
	const sound =
		sameRecord(decodedProfile, profile) &&
		sameRecord(decodeTimelineState(timelineBytes), timeline) &&
		sameRecord(decodeCalendarSyncState(calendarBytes), calendar) &&
		sameRecord(decodeFinderRecord(finderBytes), finder);

	// The profile is compared as the file holds it (text), written back by the shipped encoder.
	const content: ProfileV1 = { ...profile, generation: 0, lastSeenAt: 0 };
	for (const field of MARK_FIELDS) delete content[field];
	const contentBytes = encodeProfile(content);
	staged.push(contentBytes);
	const fileProfile: Record<string, unknown> = {
		...inner.stores.profile,
		generation: 0,
		lastSeenAt: 0
	};
	const calendarContent: CalendarSyncState = { ...calendar };
	delete calendarContent.lastAdd;
	const sameContent =
		sortedJson(JSON.parse(new TextDecoder().decode(contentBytes))) === sortedJson(fileProfile) &&
		sameRecord(timeline, inner.stores['timeline-state'] ?? emptyTimeline()) &&
		sameRecord(calendarContent, inner.stores['calendar-sync'] ?? emptyCalendar()) &&
		sameRecord(finder, inner.stores['skillbridge-finder'] ?? emptyFinder());

	if (!sound || !sameContent) throw new Error('E_WRITE_FAILED');
}
