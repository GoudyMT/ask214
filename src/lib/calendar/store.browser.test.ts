import { describe, it, expect } from 'vitest';
import { createCalendarSyncStore } from './store.svelte';
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
		store.relockSync();
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
});
