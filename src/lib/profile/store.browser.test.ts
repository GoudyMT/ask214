import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import {
	createProfileStore,
	KeystoreNotInitializedError,
	KeystoreHmacMismatchError,
	OccConflictError
} from './store.svelte';
import { withStores, reqToPromise } from '../db/schema';
import { encryptProfileRecord } from './crypto-boundary';
import { signSidecar, SidecarTamperError, type ProfileHwmPayload } from './sidecars';
import type { ProfileV1 } from './types';

type Store = 'keystore' | 'profile-hwm' | 'profile';
type Row = Record<string, unknown>;

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
});

afterEach(async () => {
	await deleteTestDb(db);
});

function readRow(store: Store): Promise<Row | undefined> {
	return withStores(db, store, 'readonly', (tx) =>
		reqToPromise<Row | undefined>(tx.objectStore(store).get(0))
	);
}

function putRow(store: Store, value: Row): Promise<void> {
	return withStores(db, store, 'readwrite', (tx) => {
		tx.objectStore(store).put(value);
	});
}

describe('ProfileStore.load', () => {
	it('throws KeystoreNotInitialized when no keystore record exists', async () => {
		const store = createProfileStore(db);
		await expect(store.load()).rejects.toThrow(KeystoreNotInitializedError);
	});

	it('returns null on a freshly-bootstrapped DB (HWM generation 0, no body)', async () => {
		await bootstrapLocalKeystore(db);
		const store = createProfileStore(db);
		expect(await store.load()).toBeNull();
	});

	it('throws KeystoreHmacMismatch when a covered keystore field is tampered', async () => {
		await bootstrapLocalKeystore(db);
		const ks = await readRow('keystore');
		if (!ks) throw new Error('test setup: keystore missing');
		await putRow('keystore', { ...ks, keystoreGeneration: 7 }); // not re-signed
		const store = createProfileStore(db);
		await expect(store.load()).rejects.toThrow(KeystoreHmacMismatchError);
	});

	it('throws SidecarTamperError when the HWM payload is tampered', async () => {
		await bootstrapLocalKeystore(db);
		const hwm = await readRow('profile-hwm');
		if (!hwm) throw new Error('test setup: HWM missing');
		const payload = hwm.payload as ProfileHwmPayload;
		await putRow('profile-hwm', { ...hwm, payload: { ...payload, generation: 999 } });
		const store = createProfileStore(db);
		await expect(store.load()).rejects.toThrow(SidecarTamperError);
	});

	it('reads, verifies, and decrypts a staged profile body', async () => {
		const { record } = await bootstrapLocalKeystore(db);
		const profile: ProfileV1 = {
			schemaVersion: 1,
			generation: 1,
			lastSeenAt: 1716700000000,
			setupIntent: 'completed',
			setupIntentChangedAt: 1716700000000,
			eaos: new TextEncoder().encode('2027-04-15')
		};
		const blob = await encryptProfileRecord(profile, record);
		const hwmPayload: ProfileHwmPayload = {
			generation: 1,
			keystoreGeneration: 0,
			epoch: 0,
			ts: 1716700000000
		};
		const hwm1 = await signSidecar('profile-hwm', hwmPayload, record.hmacKeyRef);
		await withStores(db, ['profile', 'profile-hwm'], 'readwrite', (tx) => {
			tx.objectStore('profile').put({ id: 0, rec: blob });
			tx.objectStore('profile-hwm').put({ id: 0, ...hwm1 });
		});

		const store = createProfileStore(db);
		const loaded = await store.load();
		expect(loaded).not.toBeNull();
		if (loaded?.eaos) expect(new TextDecoder().decode(loaded.eaos)).toBe('2027-04-15');
		expect(store._getStateForTest()).not.toBeNull();
	});
});

describe('ProfileStore.save', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('persists the body and bumps generation to 1', async () => {
		const store = createProfileStore(db);
		const r = await store.save({
			eaos: new TextEncoder().encode('2027-04-15'),
			setupIntent: 'completed'
		});
		expect(r.generation).toBe(1);
		const body = await readRow('profile');
		expect(body).toBeDefined();
		const hwm = await readRow('profile-hwm');
		expect(hwm).toBeDefined();
		expect((hwm?.payload as ProfileHwmPayload).generation).toBe(1);
	});

	it('roundtrips through save + load', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		const loaded = await store.load();
		expect(loaded).not.toBeNull();
		if (loaded?.eaos) expect(new TextDecoder().decode(loaded.eaos)).toBe('2027-04-15');
	});

	it('bumps the keystore ivCounter', async () => {
		const before = await readRow('keystore');
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		const after = await readRow('keystore');
		expect(after?.ivCounter as number).toBeGreaterThan(before?.ivCounter as number);
	});

	it('invokes onBroadcast with profile-updated after the lock releases', async () => {
		const events: string[] = [];
		const store = createProfileStore(db, { onBroadcast: (e) => events.push(e.type) });
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		expect(events).toEqual(['profile-updated']);
	});

	it('commits the rune inside the lock (state observable post-save)', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		const state = store._getStateForTest();
		expect(state).not.toBeNull();
		if (state) expect(state.generation).toBe(1);
	});

	it('refuses a save from a stale instance instead of clobbering (auto-OCC / H1)', async () => {
		const storeA = createProfileStore(db);
		await storeA.save({ eaos: new TextEncoder().encode('2027-01-01') }); // -> gen 1
		// storeB never loaded, so its _profile is null (simulates a 2nd tab / post-relock).
		const storeB = createProfileStore(db);
		await expect(storeB.save({ setupIntent: 'completed' })).rejects.toThrow(OccConflictError);
		// storeA's data must survive - no silent clobber.
		const loaded = await storeA.load();
		expect(loaded).not.toBeNull();
		if (loaded?.eaos) expect(new TextDecoder().decode(loaded.eaos)).toBe('2027-01-01');
	});

	it('resolves concurrent first-runs: exactly one succeeds', async () => {
		const storeA = createProfileStore(db);
		const storeB = createProfileStore(db);
		const results = await Promise.allSettled([
			storeA.save({ eaos: new TextEncoder().encode('2027-01-01') }),
			storeB.save({ eaos: new TextEncoder().encode('2027-02-02') })
		]);
		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		const r0 = rejected[0];
		if (r0 && r0.status === 'rejected') expect(r0.reason).toBeInstanceOf(OccConflictError);
	});
});

describe('ProfileStore.persona', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('derives persona from the current profile state', async () => {
		const store = createProfileStore(db);
		expect(store.persona.completeness).toBe('none');
		await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		expect(store.persona.completeness).toBe('eaos-only');
	});
});

describe('ProfileStore.relockSync', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('drops profile state and emits relocked synchronously', async () => {
		const events: string[] = [];
		const store = createProfileStore(db, { onBroadcast: (e) => events.push(e.type) });
		await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		expect(store._getStateForTest()).not.toBeNull();

		const r = store.relockSync();
		expect(r).toBeUndefined(); // synchronous void return
		expect(store._getStateForTest()).toBeNull();
		expect(events).toContain('relocked');
	});

	it('zeroizes the in-memory profile bytes before dropping the reference', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		const eaosRef = store._getStateForTest()?.eaos ?? null;
		expect(eaosRef).not.toBeNull();
		store.relockSync();
		if (eaosRef) expect(eaosRef.every((b) => b === 0)).toBe(true);
	});
});

describe('ProfileStore.lock + deferred relock', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('lock() drops state and emits relocked when no save is in flight', async () => {
		const events: string[] = [];
		const store = createProfileStore(db, { onBroadcast: (e) => events.push(e.type) });
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		await store.lock();
		expect(store._getStateForTest()).toBeNull();
		expect(events).toContain('relocked');
	});

	it('defers a relock requested mid-save until the save commits, then relocks', async () => {
		const events: string[] = [];
		const store = createProfileStore(db, { onBroadcast: (e) => events.push(e.type) });
		const savePromise = store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		const lockPromise = store.lock(); // requested while the save is still in flight
		await Promise.all([savePromise, lockPromise]);

		// the save committed (gen 1 persisted) BEFORE the deferred relock ran
		const hwm = await readRow('profile-hwm');
		expect((hwm?.payload as ProfileHwmPayload).generation).toBe(1);
		// the relock then dropped in-memory state
		expect(store._getStateForTest()).toBeNull();
		// order: data saved + announced, THEN relocked
		expect(events).toEqual(['profile-updated', 'relocked']);
	});
});
