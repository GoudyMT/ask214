import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCalendarSyncStore, CalendarRelockedError } from './store.svelte';
import { OccConflictError } from '../profile/store.svelte';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import { withStores, reqToPromise } from '../db/schema';
import type { DesiredEvent, HandedOverEvent, TaskExclusions } from './types';

// A passthrough over the cipher that counts decrypts, so a re-read that must not happen can be shown not to.
// The path is a `$lib` alias on purpose: with a relative path the mock silently never applied to the store's own
// import in this browser runner.
const seams = vi.hoisted(() => ({ decrypts: 0 }));
vi.mock('$lib/crypto/record-crypto', async (importOriginal) => {
	const real = await importOriginal<typeof import('../crypto/record-crypto')>();
	return {
		...real,
		decryptRecord: (...args: Parameters<typeof real.decryptRecord>) => {
			seams.decrypts++;
			return real.decryptRecord(...args);
		}
	};
});

// Real Chromium (SubtleCrypto + IndexedDB + navigator.locks). The calendar-sync
// store mirrors the timeline-state store's load/save/OCC/relock/wipe spine over the
// generic record-crypto boundary + a lazily-created calendar-sync-hwm sidecar; v1.0
// persists only the exclusion set.

describe('calendar-sync store', () => {
	it('defaults to empty exclusions before any save (generation 0, no HWM)', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const store = createCalendarSyncStore(db);
		await store.load();
		expect(store.exclusions).toEqual({ taskIds: [], categories: [] });
		await deleteTestDb(db);
	});

	it('persists and reloads exclusions across store instances', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createCalendarSyncStore(db);
		await a.load();
		await a.setExclusions({ taskIds: ['t1'], categories: ['medical'] });

		const b = createCalendarSyncStore(db);
		await b.load();
		expect(b.exclusions).toEqual({ taskIds: ['t1'], categories: ['medical'] });
		await deleteTestDb(db);
	});

	it('rejects a stale write with OccConflictError', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createCalendarSyncStore(db);
		const b = createCalendarSyncStore(db);
		await a.load();
		await b.load(); // both at generation 0
		await a.setExclusions({ taskIds: ['x'], categories: [] }); // a -> generation 1
		await expect(b.setExclusions({ taskIds: ['y'], categories: [] })).rejects.toThrow(
			OccConflictError
		);
		await deleteTestDb(db);
	});

	it('relockSync drops the in-memory exclusions to the empty default', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const store = createCalendarSyncStore(db);
		await store.load();
		await store.setExclusions({ taskIds: ['t1'], categories: [] });
		store.relockSync('user');
		expect(store.exclusions).toEqual({ taskIds: [], categories: [] });
		await deleteTestDb(db);
	});

	it('wipe clears the persisted exclusions', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createCalendarSyncStore(db);
		await a.load();
		await a.setExclusions({ taskIds: ['t1'], categories: [] });
		await a.wipe();

		const b = createCalendarSyncStore(db);
		await b.load();
		expect(b.exclusions).toEqual({ taskIds: [], categories: [] });
		await deleteTestDb(db);
	});

	it('dismissCard persists the timestamp and increments the count', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createCalendarSyncStore(db);
		await a.load();
		await a.dismissCard(1_000);
		await a.dismissCard(2_000);

		const b = createCalendarSyncStore(db);
		await b.load();
		expect(b.card).toEqual({ dismissedAt: 2_000, dismissCount: 2 });
		await deleteTestDb(db);
	});

	it('refuses to write while relocked, so a dismissal cannot erase the saved exclusions', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createCalendarSyncStore(db);
		await a.load();
		await a.setExclusions({ taskIds: [], categories: ['medical'] });

		// The idle timer relocks the calendar store while the record stays on disk. _generation is
		// deliberately NOT reset by relock, so OCC alone cannot catch a write built from null state.
		a.relockSync('idle');
		expect(a.ready).toBe(false);
		await expect(a.dismissCard(1_000)).rejects.toThrow(CalendarRelockedError);

		// The user's exclusion set must be intact on disk.
		const b = createCalendarSyncStore(db);
		await b.load();
		expect(b.exclusions).toEqual({ taskIds: [], categories: ['medical'] });
		await deleteTestDb(db);
	});

	it('refuses setExclusions while relocked', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createCalendarSyncStore(db);
		await a.load();
		await a.dismissCard(1_000);
		a.relockSync('user');
		await expect(a.setExclusions({ taskIds: ['t1'], categories: [] })).rejects.toThrow(
			CalendarRelockedError
		);

		const b = createCalendarSyncStore(db);
		await b.load();
		expect(b.card).toEqual({ dismissedAt: 1_000, dismissCount: 1 });
		await deleteTestDb(db);
	});

	it('merges concurrent setters against a fresh base - the second write does not drop the first', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createCalendarSyncStore(db);
		await a.load();

		// Fire both WITHOUT awaiting the first: the merge must happen inside the write lock, or the
		// second write builds on a stale base and silently drops the first field.
		const first = a.setExclusions({ taskIds: [], categories: ['medical'] });
		const second = a.dismissCard(2_000);
		await Promise.allSettled([first, second]);

		const b = createCalendarSyncStore(db);
		await b.load();
		expect(b.exclusions).toEqual({ taskIds: [], categories: ['medical'] });
		expect(b.card).toEqual({ dismissedAt: 2_000, dismissCount: 1 });
		await deleteTestDb(db);
	});

	it('the setters do not clobber each other - exclusions and the card share one record', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createCalendarSyncStore(db);
		await a.load();
		await a.dismissCard(1_000);
		await a.setExclusions({ taskIds: [], categories: ['medical'] });

		const b = createCalendarSyncStore(db);
		await b.load();
		expect(b.card).toEqual({ dismissedAt: 1_000, dismissCount: 1 }); // survived setExclusions
		expect(b.exclusions).toEqual({ taskIds: [], categories: ['medical'] });
		await deleteTestDb(db);
	});

	// A category toggle is applied to the saved set inside the write lock, like the card: two quick toggles fired
	// before the first lands both survive, instead of the second replacing the set with one that predates it.
	it('applies quick exclusion updates in order to the saved set', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createCalendarSyncStore(db);
		await a.load();
		const add = (category: 'medical' | 'admin') => (current: TaskExclusions) => ({
			taskIds: current.taskIds,
			categories: [...current.categories, category]
		});
		await Promise.allSettled([a.setExclusions(add('medical')), a.setExclusions(add('admin'))]);

		const b = createCalendarSyncStore(db);
		await b.load();
		expect(b.exclusions).toEqual({ taskIds: [], categories: ['medical', 'admin'] });
		await deleteTestDb(db);
	});

	// Damages the stored body so the next read fails after the generation was read; the returned function puts it back.
	async function damageBody(db: IDBDatabase): Promise<() => Promise<void>> {
		const row = await withStores(db, 'calendar-sync', 'readonly', (tx) =>
			reqToPromise<{ id: number; rec: Uint8Array } | undefined>(
				tx.objectStore('calendar-sync').get(0)
			)
		);
		if (!row) throw new Error('test setup: no calendar body');
		const bad = new Uint8Array(row.rec);
		bad[20] = (bad[20] ?? 0) ^ 0xff;
		const put = (rec: Uint8Array) =>
			withStores(db, 'calendar-sync', 'readwrite', (tx) => {
				tx.objectStore('calendar-sync').put({ id: 0, rec });
			});
		await put(bad);
		return () => put(row.rec);
	}
	const EMPTY: TaskExclusions = { taskIds: [], categories: [] };

	// A read that fails after a peer's save must not pair the peer's generation with the older record it still holds:
	// a write from it would pass the conflict check and lay the old record over the peer's save.
	it('refuses a write after a failed re-read, so a peer save survives', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);
		const a = createCalendarSyncStore(db);
		await a.load();
		const peer = createCalendarSyncStore(db);
		await peer.load();
		await peer.setExclusions({ taskIds: ['peer'], categories: [] });
		const restore = await damageBody(db);

		await expect(a.load()).rejects.toThrow();
		await restore();

		await expect(a.setExclusions({ taskIds: ['mine'], categories: [] })).rejects.toThrow(
			OccConflictError
		);
		const fresh = createCalendarSyncStore(db);
		await fresh.load();
		expect(fresh.exclusions).toEqual({ taskIds: ['peer'], categories: [] });
		await deleteTestDb(db);
	});

	// After a failed read the stored record is UNKNOWN, so the store says so (the timeline's `failed`) instead of
	// serving the older record as if it were current.
	it('reads as not ready, with the empty defaults, after a re-read fails', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);
		const a = createCalendarSyncStore(db);
		await a.load();
		await a.setExclusions({ taskIds: ['t1'], categories: ['medical'] });
		const peer = createCalendarSyncStore(db);
		await peer.load();
		await peer.setExclusions({ taskIds: [], categories: ['admin'] });
		expect(a.ready).toBe(true);
		expect(a.exclusions.categories).toEqual(['medical']);
		const restore = await damageBody(db);

		await expect(a.refresh()).rejects.toThrow();

		expect(a.ready).toBe(false);
		expect(a.exclusions).toEqual(EMPTY);
		await expect(a.setExclusions({ taskIds: ['mine'], categories: [] })).rejects.toThrow(
			OccConflictError
		);

		// The next read that succeeds puts the store back.
		await restore();
		await a.refresh();
		expect(a.ready).toBe(true);
		expect(a.exclusions).toEqual({ taskIds: [], categories: ['admin'] });
		await deleteTestDb(db);
	});

	describe('refresh while the page is hidden', () => {
		const stubVisibility = (state: DocumentVisibilityState) =>
			vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
		beforeEach(() => {
			seams.decrypts = 0;
		});
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('does not decrypt on a hidden re-read, and reads again once the page is visible', async () => {
			expect(document.visibilityState).toBe('visible');
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			await store.setExclusions({ taskIds: [], categories: ['medical'] });
			store.relockSync('hygiene');
			seams.decrypts = 0;

			const visibility = stubVisibility('hidden');
			await store.refresh();
			expect(seams.decrypts).toBe(0);
			expect(store.ready).toBe(false);

			visibility.mockReturnValue('visible');
			await store.refresh();
			expect(seams.decrypts).toBe(1);
			expect(store.exclusions).toEqual({ taskIds: [], categories: ['medical'] });
			await deleteTestDb(db);
		});

		it('leaves an unlocked store on what it holds until the page is visible', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			const peer = createCalendarSyncStore(db);
			await peer.load();
			await peer.setExclusions({ taskIds: [], categories: ['admin'] });
			seams.decrypts = 0;

			const visibility = stubVisibility('hidden');
			await store.refresh();
			expect(seams.decrypts).toBe(0);
			expect(store.exclusions).toEqual(EMPTY);

			visibility.mockReturnValue('visible');
			await store.refresh();
			expect(store.exclusions).toEqual({ taskIds: [], categories: ['admin'] });
			await deleteTestDb(db);
		});

		it('still refuses a locked store, hidden or not', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			await store.setExclusions({ taskIds: [], categories: ['medical'] });
			store.relockSync('user');
			seams.decrypts = 0;

			await store.refresh();
			stubVisibility('hidden');
			await store.refresh();

			expect(seams.decrypts).toBe(0);
			expect(store.ready).toBe(false);
			await deleteTestDb(db);
		});

		it('does not gate load, which is the user asking', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			await store.setExclusions({ taskIds: [], categories: ['medical'] });
			store.relockSync('user');
			seams.decrypts = 0;

			stubVisibility('hidden');
			await store.load();

			expect(seams.decrypts).toBe(1);
			expect(store.ready).toBe(true);
			await deleteTestDb(db);
		});
	});

	describe('the handed-over record', () => {
		const e: DesiredEvent = {
			taskId: 'a',
			moment: 'last',
			title: 'Last day: a',
			isoDate: '2099-01-01',
			alarmDays: []
		};
		const heldA: HandedOverEvent = {
			taskId: 'a',
			moment: 'last',
			title: 'Last day: a',
			isoDate: '2099-01-01',
			addedOn: '2026-10-04'
		};

		it('recordAdd merges the events handed over; acknowledgeStale removes the listed ones', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			await store.recordAdd([e], '2026-10-04', '2026-10-04');
			expect(store.lastAdd).toEqual([heldA]);

			const again = createCalendarSyncStore(db);
			await again.load();
			expect(again.lastAdd).toEqual([heldA]); // persisted, not only in memory

			await store.acknowledgeStale(store.lastAdd ?? []);
			expect(store.lastAdd).toEqual([]);
			await deleteTestDb(db);
		});

		it('acknowledging some events keeps the others, in memory and on disk', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			const b: DesiredEvent = { ...e, taskId: 'b', title: 'Last day: b' };
			const heldB = { ...heldA, taskId: 'b', title: 'Last day: b' };
			await store.recordAdd([e, b], '2026-10-04', '2026-10-04');
			await store.acknowledgeStale([heldA]);
			expect(store.lastAdd).toEqual([heldB]);

			const again = createCalendarSyncStore(db);
			await again.load();
			expect(again.lastAdd).toEqual([heldB]);
			await deleteTestDb(db);
		});

		// Some calendar apps keep the old date on a re-add, so a second add keeps the first add's version too.
		it('a second add keeps the version an earlier add handed over, also after a reload', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			await store.recordAdd([e], '2026-10-04', '2026-10-04');
			await store.recordAdd([{ ...e, isoDate: '2099-02-01' }], '2026-10-05', '2026-10-05');
			const both = [heldA, { ...heldA, isoDate: '2099-02-01', addedOn: '2026-10-05' }];
			expect(store.lastAdd).toEqual(both);

			const again = createCalendarSyncStore(db);
			await again.load();
			expect(again.lastAdd).toEqual(both);
			await deleteTestDb(db);
		});

		it('a relocked store refuses recordAdd and keeps its record on disk', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			await store.recordAdd([e], '2026-10-04', '2026-10-04');
			store.relockSync('hygiene');
			await expect(store.recordAdd([], '2026-10-04', '2026-10-04')).rejects.toThrow(
				CalendarRelockedError
			);
			await store.load();
			expect(store.lastAdd).toHaveLength(1);
			await deleteTestDb(db);
		});

		it('Erase all data takes the record with it', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			await store.recordAdd([e], '2026-10-04', '2026-10-04');
			await store.wipe();
			await store.load();
			expect(store.lastAdd).toBeUndefined();
			await deleteTestDb(db);
		});

		it('keeps the record out of the signed HWM, which holds counters only', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const store = createCalendarSyncStore(db);
			await store.load();
			await store.recordAdd([e], '2026-10-04', '2026-10-04');
			const hwm = await withStores(db, 'calendar-sync-hwm', 'readonly', (tx) =>
				reqToPromise<{ payload: Record<string, unknown> } | undefined>(
					tx.objectStore('calendar-sync-hwm').get(0)
				)
			);
			expect(Object.keys(hwm?.payload ?? {}).sort()).toEqual([
				'epoch',
				'generation',
				'keystoreGeneration',
				'ts'
			]);
			await deleteTestDb(db);
		});
	});
});
