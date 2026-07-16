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
		a.relockSync('idle');
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
		a.relockSync('idle');
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
		a.relockSync('user');
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
		a.relockSync('user');

		// The user taps Unlock, then immediately taps Lock (or a peer tab's change triggers a re-read
		// and the idle timer fires mid-decrypt). The load must not repopulate decrypted state into a
		// tab that has since relocked - save()/persist() already guard this; load() must too, or the
		// relock is silently undone and the idle timer will not fire again.
		const inflight = a.load();
		a.relockSync('user');
		await inflight;

		expect(a.state.tasks).toEqual({});
		await deleteTestDb(db);
	});

	it('refresh does not re-decrypt into a tab that has relocked', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('x', 'done');
		await a.setNote('y', 'PTSD eval 0900 Bldg 12');
		a.relockSync('idle');

		// An automatic re-read - a peer's signal, a failed write's recovery. Neither is the user
		// asking to unlock, so neither may put the notes back on screen.
		await a.refresh();

		expect(a.state.tasks).toEqual({});
		await deleteTestDb(db);
	});

	it('refresh restores after page hygiene - the page coming back is not a new decision', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('x', 'done');

		// What pagehide does is evict, not lock: the app dropped the plaintext because the page was
		// going away, and the page has now come back. Refusing here is what left every returning
		// user staring at a blank timeline.
		a.relockSync('hygiene');
		await a.refresh();

		expect(a.state.tasks['x']?.status).toBe('done');
		await deleteTestDb(db);
	});

	it('page hygiene after an explicit lock does not reopen it', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('x', 'done');

		// Lock, then background the app: pagehide relocks an already-locked store. If hygiene could
		// walk the state back to restorable, the next restore would silently undo the user's Lock.
		a.relockSync('user');
		a.relockSync('hygiene');
		await a.refresh();

		expect(a.state.tasks).toEqual({});
		await deleteTestDb(db);
	});

	it('refresh re-reads while the tab is unlocked, so a peer change still lands', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		const b = createTimelineStateStore(db);
		await a.load();
		await b.load();
		await a.setStatus('x', 'done');

		// b never relocked, so the cross-tab re-read must still work - that is the bus's whole point.
		await b.refresh();

		expect(b.state.tasks['x']?.status).toBe('done');
		await deleteTestDb(db);
	});

	it('the user unlocking after a relock still loads - refresh refuses, load does not', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('x', 'done');
		a.relockSync('user');
		await a.refresh();
		expect(a.state.tasks).toEqual({});

		// load() IS the unlock. It must always decrypt, or the Unlock button is dead.
		await a.load();
		expect(a.state.tasks['x']?.status).toBe('done');

		// And a later automatic re-read must work again now the user has unlocked.
		await a.refresh();
		expect(a.state.tasks['x']?.status).toBe('done');
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
