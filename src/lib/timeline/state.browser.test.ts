import { describe, it, expect } from 'vitest';
import { createTimelineStateStore } from './state.svelte';
import { OccConflictError } from '../profile/store.svelte';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';

// Real Chromium (SubtleCrypto + IndexedDB + navigator.locks). The timeline-state
// store mirrors the profile store's load/save/OCC/relock/wipe spine but uses the
// generic record-crypto boundary + a lazily-created timeline-state-hwm sidecar.

describe('timeline-state store', () => {
	it('persists task status across store instances (lazy HWM on first save)', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		expect(a.state.tasks).toEqual({}); // no timeline state yet (generation 0, no HWM)
		await a.setStatus('dd214-review', 'done');

		const b = createTimelineStateStore(db);
		await b.load();
		expect(b.state.tasks['dd214-review']?.status).toBe('done');
		await deleteTestDb(db);
	});

	it('persists a note (encrypted at rest)', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setNote('skillbridge', 'reached out to 3 hosts');

		const b = createTimelineStateStore(db);
		await b.load();
		expect(b.state.tasks['skillbridge']?.notes).toBe('reached out to 3 hosts');
		await deleteTestDb(db);
	});

	it('rejects a stale write with OccConflictError', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		const b = createTimelineStateStore(db);
		await a.load();
		await b.load(); // both at generation 0
		await a.setStatus('x', 'done'); // a -> generation 1
		await expect(b.setStatus('y', 'skipped')).rejects.toThrow(OccConflictError);
		await deleteTestDb(db);
	});

	it('relockSync drops the in-memory state', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('x', 'done');
		a.relockSync();
		expect(a.state.tasks).toEqual({});
		await deleteTestDb(db);
	});

	it('wipe clears the timeline state', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('x', 'done');
		await a.wipe();

		const b = createTimelineStateStore(db);
		await b.load();
		expect(b.state.tasks).toEqual({});
		await deleteTestDb(db);
	});
});
