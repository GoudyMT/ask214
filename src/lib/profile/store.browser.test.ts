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

	it('rejects a stale writer via OCC (expectedLastReadGeneration mismatch)', async () => {
		const storeA = createProfileStore(db);
		await storeA.save({ eaos: new TextEncoder().encode('2027-01-01') }); // -> gen 1
		const storeB = createProfileStore(db);
		await expect(
			storeB.save(
				{ eaos: new TextEncoder().encode('2027-02-02') },
				{ expectedLastReadGeneration: 0 }
			)
		).rejects.toThrow(OccConflictError);
	});

	it('resolves concurrent first-runs: exactly one succeeds', async () => {
		const storeA = createProfileStore(db);
		const storeB = createProfileStore(db);
		const results = await Promise.allSettled([
			storeA.save(
				{ eaos: new TextEncoder().encode('2027-01-01') },
				{ expectedLastReadGeneration: 0 }
			),
			storeB.save(
				{ eaos: new TextEncoder().encode('2027-02-02') },
				{ expectedLastReadGeneration: 0 }
			)
		]);
		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		const r0 = rejected[0];
		if (r0 && r0.status === 'rejected') expect(r0.reason).toBeInstanceOf(OccConflictError);
	});
});
