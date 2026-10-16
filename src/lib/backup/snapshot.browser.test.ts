import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { RunAbortedError } from '../db/locks';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { reqToPromise, withStores, type StoreName } from '../db/schema';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { zeroizeRecord } from '../profile/lifecycle';
import { createProfileStore } from '../profile/store.svelte';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { takeSnapshot, type SnapshotResult } from './snapshot';

// A call log over the paths a snapshot must not take. Each factory hands back the real store with its read and write
// entry points recording their names; the lock helpers record theirs; the wipe records the records it was given. The
// paths are `$lib` aliases on purpose: with a relative path a mock silently never applied to the module's own import
// in this browser runner.
const seams = vi.hoisted(() => {
	const calls: string[] = [];
	const wiped: Record<string, unknown>[] = [];
	function watch<T extends object>(name: string, store: T): T {
		const target = store as Record<string, unknown>;
		for (const method of ['load', 'save', 'refresh', 'lock']) {
			const original = target[method];
			if (typeof original !== 'function') continue;
			target[method] = (...args: unknown[]) => {
				calls.push(`${name}.${method}`);
				return (original as (...a: unknown[]) => unknown)(...args);
			};
		}
		return store;
	}
	return { calls, wiped, watch };
});

vi.mock('$lib/profile/lifecycle', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/lifecycle')>();
	return {
		...real,
		zeroizeRecord: (rec: Record<string, unknown>): void => {
			seams.wiped.push(rec);
			real.zeroizeRecord(rec);
		}
	};
});

vi.mock('$lib/profile/store.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/store.svelte')>();
	return {
		...real,
		createProfileStore: (...args: Parameters<typeof real.createProfileStore>) =>
			seams.watch('profile', real.createProfileStore(...args))
	};
});

vi.mock('$lib/timeline/state.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('../timeline/state.svelte')>();
	return {
		...real,
		createTimelineStateStore: (...args: Parameters<typeof real.createTimelineStateStore>) =>
			seams.watch('timeline', real.createTimelineStateStore(...args))
	};
});

vi.mock('$lib/calendar/store.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('../calendar/store.svelte')>();
	return {
		...real,
		createCalendarSyncStore: (...args: Parameters<typeof real.createCalendarSyncStore>) =>
			seams.watch('calendar', real.createCalendarSyncStore(...args))
	};
});

vi.mock('$lib/db/locks', async (importOriginal) => {
	const real = await importOriginal<typeof import('../db/locks')>();
	return {
		...real,
		withWriteLocks: (...args: Parameters<typeof real.withWriteLocks>) => {
			seams.calls.push('withWriteLocks');
			return real.withWriteLocks(...args);
		},
		rotateOrUpgrade: (...args: Parameters<typeof real.rotateOrUpgrade>) => {
			seams.calls.push('rotateOrUpgrade');
			return real.rotateOrUpgrade(...args);
		}
	};
});

type Row = Record<string, unknown>;

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	seams.calls.length = 0;
	seams.wiped.length = 0;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await deleteTestDb(db);
});

const readRow = (store: StoreName) =>
	withStores(db, store, 'readonly', (tx) =>
		reqToPromise<Row | undefined>(tx.objectStore(store).get(0))
	);

const putRow = (store: StoreName, value: Row) =>
	withStores(db, store, 'readwrite', (tx) => {
		tx.objectStore(store).put(value);
	});

const deleteRow = (store: StoreName) =>
	withStores(db, store, 'readwrite', (tx) => {
		tx.objectStore(store).delete(0);
	});

/** A device whose setup is finished, as the app's own stores write it. */
async function finishedDevice() {
	await bootstrapLocalKeystore(db);
	const profile = createProfileStore(db);
	await profile.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
	return profile;
}

async function loadedTimeline() {
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	return timeline;
}

async function loadedCalendar() {
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	return calendar;
}

/** The decoded profile is the caller's to wipe; a test does the same when it is done with it. */
async function snapshotOf(signal?: AbortSignal): Promise<SnapshotResult> {
	const snap = await takeSnapshot(db, signal);
	if (snap.ok) zeroizeRecord(snap.profile as unknown as Record<string, unknown>);
	return snap;
}

const failedAt = (store: 'profile' | 'timeline' | 'calendar') =>
	({ ok: false, code: 'E_SNAPSHOT_FAILED', store }) as const;

const SEVEN_STORES = [
	'calendar-sync',
	'calendar-sync-hwm',
	'keystore',
	'profile',
	'profile-hwm',
	'timeline-state',
	'timeline-state-hwm'
];

const STORE_ROWS = [
	{ store: 'profile', body: 'profile', mark: 'profile-hwm' },
	{ store: 'timeline', body: 'timeline-state', mark: 'timeline-state-hwm' },
	{ store: 'calendar', body: 'calendar-sync', mark: 'calendar-sync-hwm' }
] as const;

async function fullDevice() {
	const profile = await finishedDevice();
	const timeline = await loadedTimeline();
	await timeline.setStatus('va-gov-account', 'done');
	const calendar = await loadedCalendar();
	await calendar.setExclusions({ taskIds: ['job-search'], categories: ['finance'] });
	return { profile, timeline, calendar };
}

describe('takeSnapshot: what a backup reads', () => {
	it('a fresh setup snapshots the profile with no timeline or calendar', async () => {
		await finishedDevice();
		const snap = await takeSnapshot(db);
		expect(snap.ok).toBe(true);
		if (!snap.ok) return;
		expect(snap.timeline).toBeNull();
		expect(snap.calendar).toBeNull();
		expect(snap.gens).toEqual({ profile: 1, timeline: 0, calendar: 0 });
		expect(snap.profile.setupIntent).toBe('completed');
		expect(new TextDecoder().decode(snap.profile.eaos ?? new Uint8Array())).toBe('2027-04-15');
		zeroizeRecord(snap.profile as unknown as Record<string, unknown>);
	});

	// The screen locking itself drops the notes from memory; the backup reads the device, so they are still there.
	it('a hygiene-relocked timeline still exports its tasks', async () => {
		await finishedDevice();
		const timeline = await loadedTimeline();
		await timeline.setStatus('va-gov-account', 'done');
		await timeline.setStatus('tap-course', 'skipped');
		timeline.relockSync('hygiene');
		expect(timeline.ready).toBe(false);

		const snap = await takeSnapshot(db);
		expect(snap.ok).toBe(true);
		if (!snap.ok) return;
		expect(snap.timeline?.tasks).toEqual({
			'va-gov-account': { status: 'done' },
			'tap-course': { status: 'skipped' }
		});
		expect(snap.gens.timeline).toBe(2);
		zeroizeRecord(snap.profile as unknown as Record<string, unknown>);
	});

	// A writer that skips the locks (an older tab) must still land wholly before or after the cut. The peer's rows are
	// staged first, put back, and written again the moment the snapshot opens its transaction.
	it('a peer write lands wholly before or after the cut', async () => {
		const profile = await finishedDevice();
		const timeline = await loadedTimeline();
		await timeline.setStatus('va-gov-account', 'done');
		const peerStores: StoreName[] = [
			'profile',
			'profile-hwm',
			'keystore',
			'timeline-state',
			'timeline-state-hwm'
		];
		const readPeerRows = async () =>
			Promise.all(peerStores.map(async (store) => [store, await readRow(store)] as const));
		const writePeerRows = (rows: Awaited<ReturnType<typeof readPeerRows>>) =>
			withStores(db, peerStores, 'readwrite', (tx) => {
				for (const [store, row] of rows) if (row) tx.objectStore(store).put(row);
			});

		const older = await readPeerRows();
		await profile.save({});
		await timeline.setStatus('va-gov-account', 'skipped');
		const newer = await readPeerRows();
		await writePeerRows(older);

		const open = db.transaction.bind(db);
		let peerWrite: Promise<void> | null = null;
		let peerStarted = false;
		vi.spyOn(db, 'transaction').mockImplementation((...args: Parameters<typeof open>) => {
			const tx = open(...args);
			if (!peerStarted) {
				// Set first: the peer's own transaction comes back through this spy.
				peerStarted = true;
				peerWrite = writePeerRows(newer);
			}
			return tx;
		});

		const snap = await takeSnapshot(db);
		await peerWrite;
		expect(snap.ok).toBe(true);
		if (!snap.ok) return;
		const held = {
			profile: snap.gens.profile,
			timeline: snap.gens.timeline,
			status: snap.timeline?.tasks['va-gov-account']?.status
		};
		expect([
			{ profile: 1, timeline: 1, status: 'done' },
			{ profile: 2, timeline: 2, status: 'skipped' }
		]).toContainEqual(held);
		zeroizeRecord(snap.profile as unknown as Record<string, unknown>);
	});
});

describe('takeSnapshot: what it refuses', () => {
	// Reading a missing mark as "nothing written" would export null, and a restore would write an empty record over
	// the person's real one.
	it.each(STORE_ROWS)('snapshot refuses body-without-mark naming the $store', async (row) => {
		await fullDevice();
		await deleteRow(row.mark);
		expect(await snapshotOf()).toEqual(failedAt(row.store));
	});

	it.each(STORE_ROWS)('a mark without a body refuses naming the $store', async (row) => {
		await fullDevice();
		await deleteRow(row.body);
		expect(await snapshotOf()).toEqual(failedAt(row.store));
	});

	// Only the write time is changed: the generation still matches its body, so only the sidecar's own check can notice.
	async function tamperSidecar(mark: StoreName) {
		const row = await readRow(mark);
		if (!row) throw new Error('test setup: sidecar missing');
		const payload = row.payload as { ts: number };
		await putRow(mark, { ...row, payload: { ...payload, ts: payload.ts + 1 } });
	}

	it.each(STORE_ROWS)('a tampered sidecar refuses naming the $store', async (row) => {
		await fullDevice();
		await tamperSidecar(row.mark);
		expect(await snapshotOf()).toEqual(failedAt(row.store));
	});

	// A refused backup must not leave the person's profile dates sitting in memory as bytes.
	it('a profile already read is wiped when a later store fails', async () => {
		await fullDevice();
		await tamperSidecar('timeline-state-hwm');
		seams.wiped.length = 0;
		expect(await takeSnapshot(db)).toEqual(failedAt('timeline'));
		expect(seams.wiped).toHaveLength(1);
		expect(seams.wiped[0]?.eaos).toEqual(new Uint8Array('2027-04-15'.length));
	});

	// The MAC value is changed and nothing else: every body still decrypts, so only the key record's own check can
	// notice.
	it('a tampered keystore refuses naming profile', async () => {
		await fullDevice();
		const keystore = await readRow('keystore');
		if (!keystore) throw new Error('test setup: keystore missing');
		await putRow('keystore', { ...keystore, recordHmac: new ArrayBuffer(32) });
		expect(await snapshotOf()).toEqual(failedAt('profile'));
	});

	// The start rule normally stops a backup before this point; the snapshot refuses on its own as well.
	it('setup not completed is E_BACKUP_UNAVAILABLE', async () => {
		await bootstrapLocalKeystore(db);
		expect(await snapshotOf()).toEqual({ ok: false, code: 'E_BACKUP_UNAVAILABLE' });

		await createProfileStore(db).save({});
		expect(await snapshotOf()).toEqual({ ok: false, code: 'E_BACKUP_UNAVAILABLE' });
	});

	it('an aborted run signal before the lock is granted reads nothing', async () => {
		await fullDevice();
		const run = new AbortController();
		run.abort();
		const spy = vi.spyOn(db, 'transaction');
		await expect(takeSnapshot(db, run.signal)).rejects.toBeInstanceOf(RunAbortedError);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('takeSnapshot: how it reads', () => {
	it('one readonly transaction over exactly the seven stores, never byok', async () => {
		await fullDevice();
		const spy = vi.spyOn(db, 'transaction');
		await snapshotOf();
		expect(spy).toHaveBeenCalledTimes(1);
		const [stores, mode] = spy.mock.calls[0] ?? [];
		expect([...(stores as string[])].sort()).toEqual(SEVEN_STORES);
		expect(mode).toBe('readonly');
	});

	// The locks are not re-entrant and a store's own read or save would take one; a broadcast would tell the other tabs
	// something changed when nothing did.
	it('only raw helpers run inside the lock', async () => {
		await fullDevice();
		const post = vi.spyOn(BroadcastChannel.prototype, 'postMessage');
		seams.calls.length = 0;
		await snapshotOf();
		expect(seams.calls).toEqual(['withWriteLocks']);
		expect(post).not.toHaveBeenCalled();
	});
});
