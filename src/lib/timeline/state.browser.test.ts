import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { createTimelineStateStore, TimelineRelockedError } from './state.svelte';
import { readPlan, SKILLBRIDGE_PLAN_KEY } from './skillbridge-plan';
import { OccConflictError } from '../profile/store.svelte';
import { signSidecar } from '../profile/sidecars';
import { encryptRecord } from '../crypto/record-crypto';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import type { KeystoreRecordV1 } from '../keystore/record';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import { withStores, reqToPromise } from '../db/schema';

async function reload(db: IDBDatabase) {
	const store = createTimelineStateStore(db);
	await store.load();
	return store;
}

// A record as another writer left it (a peer, a newer build, a tampered disk), stored at generation 1.
async function seedRecord(db: IDBDatabase, json: string) {
	const ks = await withStores(db, 'keystore', 'readonly', (tx) =>
		reqToPromise<KeystoreRecordV1>(tx.objectStore('keystore').get(0))
	);
	const blob = await encryptRecord(
		{ storeName: 'timeline-state', recordId: 'self', schemaVersion: 1 },
		new TextEncoder().encode(json),
		ks,
		1
	);
	const hwm = await signSidecar(
		'timeline-state-hwm',
		{ generation: 1, keystoreGeneration: ks.keystoreGeneration, epoch: ks.epoch, ts: Date.now() },
		ks.hmacKeyRef
	);
	await withStores(db, ['timeline-state', 'timeline-state-hwm'], 'readwrite', (tx) => {
		tx.objectStore('timeline-state').put({ id: 0, rec: blob });
		tx.objectStore('timeline-state-hwm').put({ id: 0, ...hwm });
	});
}

// The page's visibility is the browser's to report; a test sets it for one check and puts it back.
function stubVisibility() {
	const spy = vi.spyOn(document, 'visibilityState', 'get');
	return {
		set: (v: DocumentVisibilityState) => spy.mockReturnValue(v),
		restore: () => spy.mockRestore()
	};
}

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

	it('keeps a status-only snooze across store instances', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setSnooze('skillbridge-plan', '2027-04-01');
		await a.setStatus('skillbridge-plan', 'snoozed');

		const b = createTimelineStateStore(db);
		await b.load();
		expect(b.state.tasks['skillbridge-plan']).toEqual({ status: 'snoozed' });
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

	// The calendar file cannot write a snooze date that is no day or lies past the last one it can name, so no such date
	// is stored. The check never looks at today or at the input's minimum: a stored record must stay valid after a clock
	// change, and the SkillBridge answer stores a date the user did not type.
	describe('setSnooze with a date the calendar file cannot write', () => {
		const stored = (db: IDBDatabase) =>
			withStores(db, ['timeline-state', 'timeline-state-hwm'], 'readonly', async (tx) => ({
				state: await reqToPromise(tx.objectStore('timeline-state').get(0)),
				hwm: await reqToPromise(tx.objectStore('timeline-state-hwm').get(0))
			}));

		for (const bad of ['2026-13-45', '3abcdefghi', '10000-01-01', '9999-12-31', '', '2027-02-30']) {
			it(`rejects ${JSON.stringify(bad)} with E_SNOOZE_DATE and writes nothing`, async () => {
				const db = await openTestDb();
				await bootstrapLocalKeystore(db);
				const a = createTimelineStateStore(db);
				await a.load();
				await a.setStatus('x', 'done');
				const before = await stored(db);

				let pending: Promise<void> | undefined;
				expect(() => {
					pending = a.setSnooze('x', bad);
				}).not.toThrow();
				await expect(pending).rejects.toThrow('E_SNOOZE_DATE');

				expect(await stored(db)).toEqual(before);
				expect(a.state.tasks).toEqual({ x: { status: 'done' } });
				const b = createTimelineStateStore(db);
				await b.load();
				expect(b.state.tasks).toEqual({ x: { status: 'done' } });
				await deleteTestDb(db);
			});
		}

		for (const good of ['9999-12-30', '2027-04-01', '2020-01-01']) {
			it(`accepts ${good}, whatever today is`, async () => {
				const db = await openTestDb();
				await bootstrapLocalKeystore(db);
				const a = createTimelineStateStore(db);
				await a.load();
				await a.setSnooze('x', good);
				const b = createTimelineStateStore(db);
				await b.load();
				expect(b.state.tasks['x']).toEqual({ status: 'snoozed', snoozeUntil: good });
				await deleteTestDb(db);
			});
		}
	});

	// A record written by hand (a peer, an older build, a tampered disk) can hold a task named __proto__; it must never
	// become the prototype of the tasks this tab keeps and writes back.
	it('a stored task named __proto__ never reaches the tasks the next write keeps', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);
		await seedRecord(
			db,
			'{"schemaVersion":1,"tasks":{"__proto__":{"status":"done"},"x":{"notes":"keep"}}}'
		);

		const a = createTimelineStateStore(db);
		await a.load();
		expect(Object.getPrototypeOf(a.state.tasks)).toBe(Object.prototype);
		await a.setStatus('y', 'done');
		for (const tasks of [a.state.tasks, (await reload(db)).state.tasks]) {
			expect(Object.getPrototypeOf(tasks)).toBe(Object.prototype);
			expect(Object.hasOwn(tasks, '__proto__')).toBe(false);
			expect(Object.keys(tasks).sort()).toEqual(['x', 'y']);
			expect(tasks['status' as string]).toBeUndefined();
		}
		await deleteTestDb(db);
	});

	// A field a newer release wrote on a task is kept when decoding, and must survive this tab's own write to that task.
	describe('a task field this release does not know', () => {
		it('survives a status write to the same task', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			await seedRecord(
				db,
				'{"schemaVersion":1,"tasks":{"a":{"status":"done","pinned":true},"b":{"flag":[1,2]}}}'
			);
			const a = await reload(db);
			await a.setStatus('a', 'skipped');
			expect(a.state.tasks['a']).toEqual({ status: 'skipped', pinned: true });

			const b = await reload(db);
			expect(b.state.tasks).toEqual({
				a: { status: 'skipped', pinned: true },
				b: { flag: [1, 2] }
			});
			await deleteTestDb(db);
		});

		it('survives a snooze and a note write, and clearing a known field still removes it', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			await seedRecord(db, '{"schemaVersion":1,"tasks":{"a":{"pinned":true}}}');
			const a = await reload(db);
			await a.setSnooze('a', '2027-04-01');
			await a.setNote('a', 'call back');
			expect((await reload(db)).state.tasks['a']).toEqual({
				status: 'snoozed',
				snoozeUntil: '2027-04-01',
				notes: 'call back',
				pinned: true
			});

			await a.setStatus('a', undefined);
			await a.setNote('a', undefined);
			expect((await reload(db)).state.tasks['a']).toEqual({ pinned: true });
			await deleteTestDb(db);
		});

		it('does not hide a SkillBridge answer saved on the same task', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			await seedRecord(
				db,
				`{"schemaVersion":1,"tasks":{"${SKILLBRIDGE_PLAN_KEY}":{"pinned":true}}}`
			);
			const a = await reload(db);
			await a.setStatus(SKILLBRIDGE_PLAN_KEY, 'done');

			const stored = (await reload(db)).state.tasks[SKILLBRIDGE_PLAN_KEY];
			expect(readPlan(stored, '2028-06-30', '2026-10-07')).toMatchObject({ answer: 'yes' });
			await deleteTestDb(db);
		});

		it('leaves no entry behind once no field is left, known or not', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			await seedRecord(db, '{"schemaVersion":1,"tasks":{"a":{"status":"done"}}}');
			const a = await reload(db);
			await a.setStatus('a', undefined);
			expect(a.state.tasks).toEqual({});
			expect((await reload(db)).state.tasks).toEqual({});
			await deleteTestDb(db);
		});

		it('never copies a __proto__ key onto the entry a write keeps', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			await seedRecord(
				db,
				'{"schemaVersion":1,"tasks":{"a":{"status":"done","pinned":true,"__proto__":{"polluted":true}}}}'
			);
			const a = await reload(db);
			await a.setStatus('a', 'skipped');
			for (const state of [a.state, (await reload(db)).state]) {
				const task = state.tasks['a'];
				expect(task).toEqual({ status: 'skipped', pinned: true });
				expect(Object.getPrototypeOf(task)).toBe(Object.prototype);
				expect(Object.hasOwn(task as object, '__proto__')).toBe(false);
				expect((task as Record<string, unknown>)['polluted']).toBeUndefined();
			}
			await deleteTestDb(db);
		});
	});

	describe('refresh while the page is hidden', () => {
		let visibility: ReturnType<typeof stubVisibility>;
		let decrypt: MockInstance<SubtleCrypto['decrypt']>;
		beforeEach(() => {
			visibility = stubVisibility();
			decrypt = vi.spyOn(crypto.subtle, 'decrypt');
		});
		afterEach(() => {
			visibility.restore();
			decrypt.mockRestore();
		});

		it('runs in a page the browser reports visible', () => {
			visibility.restore();
			expect(document.visibilityState).toBe('visible');
		});

		it('reads nothing after page hygiene until the page is visible again', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const a = createTimelineStateStore(db);
			await a.load();
			await a.setStatus('x', 'done');
			a.relockSync('hygiene');
			decrypt.mockClear();

			visibility.set('hidden');
			await a.refresh();
			expect(decrypt).not.toHaveBeenCalled();
			expect(a.ready).toBe(false);
			expect(a.state.tasks).toEqual({});

			visibility.set('visible');
			await a.refresh();
			expect(decrypt).toHaveBeenCalled();
			expect(a.state.tasks['x']?.status).toBe('done');
			await deleteTestDb(db);
		});

		it('leaves an unlocked store as it is, so a peer change lands when the page is seen again', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const a = createTimelineStateStore(db);
			const b = createTimelineStateStore(db);
			await a.load();
			await b.load();
			await a.setStatus('x', 'done');
			decrypt.mockClear();

			visibility.set('hidden');
			await b.refresh();
			expect(decrypt).not.toHaveBeenCalled();
			expect(b.state.tasks).toEqual({});

			visibility.set('visible');
			await b.refresh();
			expect(b.state.tasks['x']?.status).toBe('done');
			await deleteTestDb(db);
		});

		it('never reads a locked store, hidden or visible', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const a = createTimelineStateStore(db);
			await a.load();
			await a.setStatus('x', 'done');
			a.relockSync('user');
			decrypt.mockClear();

			for (const state of ['hidden', 'visible'] as const) {
				visibility.set(state);
				await a.refresh();
				expect(decrypt, state).not.toHaveBeenCalled();
				expect(a.state.tasks, state).toEqual({});
			}
			await deleteTestDb(db);
		});

		it('does not gate load, which is the user unlocking', async () => {
			const db = await openTestDb();
			await bootstrapLocalKeystore(db);
			const a = createTimelineStateStore(db);
			await a.load();
			await a.setStatus('x', 'done');
			a.relockSync('user');

			visibility.set('hidden');
			await a.load();
			expect(a.state.tasks['x']?.status).toBe('done');
			await deleteTestDb(db);
		});
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

	it('is ready only while its record is loaded', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const store = createTimelineStateStore(db);
		expect(store.ready).toBe(false);
		await store.load();
		expect(store.ready).toBe(true);
		store.relockSync('user');
		expect(store.ready).toBe(false);
		await deleteTestDb(db);
	});

	// A failed load says so, so the Timeline can show a note instead of every task as not started; a load that succeeds
	// clears it.
	it('says its load failed, until a load succeeds', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);
		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('dd214-review', 'done');
		const body = await withStores(db, 'timeline-state', 'readonly', (tx) =>
			reqToPromise(tx.objectStore('timeline-state').get(0))
		);
		await withStores(db, 'timeline-state', 'readwrite', (tx) => {
			tx.objectStore('timeline-state').delete(0);
		});

		const b = createTimelineStateStore(db);
		expect(b.failed).toBe(false);
		await expect(b.load()).rejects.toThrow('E_TIMELINE_BODY_MISSING');
		expect(b.failed).toBe(true);

		await withStores(db, 'timeline-state', 'readwrite', (tx) => {
			tx.objectStore('timeline-state').put(body);
		});
		await b.load();
		expect(b.failed).toBe(false);
		expect(b.state.tasks['dd214-review']?.status).toBe('done');
		await deleteTestDb(db);
	});

	// Locked is the user's lock, which only a load the user asks for opens: page hygiene on top of it does not move it, so
	// a page that sees it can offer Unlock.
	it('is locked from a lock until a load opens it', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);
		const store = createTimelineStateStore(db);
		await store.load();
		expect(store.locked).toBe(false);
		store.relockSync('user');
		expect(store.locked).toBe(true);
		store.relockSync('hygiene');
		expect(store.locked).toBe(true);
		await store.load();
		expect(store.locked).toBe(false);
		await deleteTestDb(db);
	});

	// The user's Unlock is a new attempt: the Timeline waits for it instead of repeating the last failure.
	it('clears a past failure when the user unlocks', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);
		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('dd214-review', 'done');
		const body = await withStores(db, 'timeline-state', 'readonly', (tx) =>
			reqToPromise(tx.objectStore('timeline-state').get(0))
		);
		await withStores(db, 'timeline-state', 'readwrite', (tx) => {
			tx.objectStore('timeline-state').delete(0);
		});
		const b = createTimelineStateStore(db);
		await expect(b.load()).rejects.toThrow('E_TIMELINE_BODY_MISSING');
		expect(b.failed).toBe(true);
		await withStores(db, 'timeline-state', 'readwrite', (tx) => {
			tx.objectStore('timeline-state').put(body);
		});

		b.relockSync('user');
		const retry = b.load();
		expect(b.failed).toBe(false);
		await retry;
		expect(b.ready).toBe(true);
		await deleteTestDb(db);
	});

	// An automatic re-read (a page coming back, a peer's change) keeps the failure while it runs: the note stays mounted
	// and is not announced again on every return.
	it('keeps a failure through an automatic re-read', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);
		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('dd214-review', 'done');
		await withStores(db, 'timeline-state', 'readwrite', (tx) => {
			tx.objectStore('timeline-state').delete(0);
		});
		const b = createTimelineStateStore(db);
		await expect(b.load()).rejects.toThrow('E_TIMELINE_BODY_MISSING');

		b.relockSync('hygiene');
		const reread = b.refresh();
		expect(b.failed).toBe(true);
		await expect(reread).rejects.toThrow('E_TIMELINE_BODY_MISSING');
		expect(b.failed).toBe(true);
		await deleteTestDb(db);
	});

	// A re-read that fails after a peer saved keeps the store's old generation with its old statuses, so a write from it
	// is refused rather than laid over the peer's save.
	it('refuses a write after a failed re-read, so a newer save survives', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);
		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('t1', 'done');
		const peer = createTimelineStateStore(db);
		await peer.load();
		await peer.setStatus('t2', 'done');

		const body = await withStores(db, 'timeline-state', 'readonly', (tx) =>
			reqToPromise(tx.objectStore('timeline-state').get(0))
		);
		await withStores(db, 'timeline-state', 'readwrite', (tx) => {
			tx.objectStore('timeline-state').delete(0);
		});
		await expect(a.load()).rejects.toThrow('E_TIMELINE_BODY_MISSING');
		await withStores(db, 'timeline-state', 'readwrite', (tx) => {
			tx.objectStore('timeline-state').put(body);
		});

		await expect(a.setStatus('t3', 'done')).rejects.toThrow(OccConflictError);
		const fresh = createTimelineStateStore(db);
		await fresh.load();
		expect(fresh.state.tasks['t2']?.status).toBe('done');
		await deleteTestDb(db);
	});
});
