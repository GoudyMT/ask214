import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import {
	createProfileStore,
	KeystoreNotInitializedError,
	KeystoreHmacMismatchError
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
