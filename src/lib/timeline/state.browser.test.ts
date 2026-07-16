import { describe, it, expect } from 'vitest';
import { createTimelineStateStore, TimelineRelockedError } from './state.svelte';
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

	it('a write while relocked cannot erase the saved timeline', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('x', 'done');
		await a.setNote('y', 'reached out to 3 hosts');

		// The idle timer relocks the store while the record stays on disk. relock deliberately
		// leaves _generation intact, so OCC alone cannot catch a write built from null state - and
		// a null state must mean "unknown", never "the user has done nothing".
		a.relockSync();
		// Attempt the write; whether it refuses loudly or no-ops is the store's choice. What is not
		// negotiable is the line below: the user's record survives either way.
		await a.setStatus('z', 'done').catch(() => {});

		// Every task the user had recorded must still be on disk, byte for byte.
		const b = createTimelineStateStore(db);
		await b.load();
		expect(b.state.tasks).toEqual({
			x: { status: 'done' },
			y: { notes: 'reached out to 3 hosts' }
		});
		await deleteTestDb(db);
	});

	it('a relocked write rejects, so the caller can reload rather than clobber', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('x', 'done');
		a.relockSync();
		await expect(a.setStatus('y', 'done')).rejects.toThrow(TimelineRelockedError);
		await deleteTestDb(db);
	});

	it('merges concurrent actions against a fresh base - the second does not drop the first', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();

		// Fire both WITHOUT awaiting the first: the merge must happen inside the write lock, or the
		// second action builds on a base the first has already superseded and silently drops it.
		// OCC cannot catch this - the first write advances the generation the second compares to.
		const first = a.setStatus('x', 'done');
		const second = a.setNote('y', 'reached out to 3 hosts');
		await Promise.allSettled([first, second]);

		const b = createTimelineStateStore(db);
		await b.load();
		expect(b.state.tasks).toEqual({
			x: { status: 'done' },
			y: { notes: 'reached out to 3 hosts' }
		});
		await deleteTestDb(db);
	});

	it('a relock landing during a load is not undone when that load finishes', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('x', 'done');
		a.relockSync();

		// The user taps Unlock, then immediately taps Lock (or a peer tab's change triggers a re-read
		// and the idle timer fires mid-decrypt). The load must not repopulate decrypted state into a
		// tab that has since relocked - save()/persist() already guard this; load() must too, or the
		// relock is silently undone and the idle timer will not fire again.
		const inflight = a.load();
		a.relockSync();
		await inflight;

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
