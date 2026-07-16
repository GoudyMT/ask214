import { describe, it, expect } from 'vitest';
import { createCalendarSyncStore, CalendarRelockedError } from './store.svelte';
import { OccConflictError } from '../profile/store.svelte';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';

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
});
