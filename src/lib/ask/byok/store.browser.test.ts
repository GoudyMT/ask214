import { describe, it, expect } from 'vitest';
import { createByokStore } from './store';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { KeystoreNotInitializedError } from '$lib/profile/store.svelte';
import { withStores, reqToPromise } from '$lib/db/schema';
import { openTestDb, deleteTestDb } from '$lib/db/_test-helpers';

// Real Chromium (SubtleCrypto + IndexedDB). The byok store persists the user's BYO API key as a single
// encrypted self-row through the shared record-crypto boundary (AES-GCM under the keystore dataKeyRef).
// No HWM/OCC and no in-memory caching: the key is read-decrypted on demand and never held resident.

const KEY = 'sk-ant-api03-test-abc123XYZ';

describe('byok store', () => {
	it('round-trips an API key through the record-crypto boundary', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const store = createByokStore(db);
		expect(await store.readApiKey()).toBeNull(); // unset -> null, not an error
		await store.saveApiKey(KEY);
		expect(await store.readApiKey()).toBe(KEY);

		// A fresh instance (a new tab) reads the same persisted key - the store holds no state itself.
		expect(await createByokStore(db).readApiKey()).toBe(KEY);
		await deleteTestDb(db);
	});

	it('clears the key', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const store = createByokStore(db);
		await store.saveApiKey(KEY);
		await store.clearApiKey();
		expect(await store.readApiKey()).toBeNull();
		await deleteTestDb(db);
	});

	it('never writes the key as plaintext to IDB', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);
		await createByokStore(db).saveApiKey(KEY);

		const row = await withStores(db, 'byok', 'readonly', (tx) =>
			reqToPromise<{ id: number; rec: Uint8Array }>(tx.objectStore('byok').get(0))
		);
		const raw = new TextDecoder().decode(row.rec);
		expect(raw).not.toContain(KEY);
		expect(raw).not.toContain('sk-ant');
		await deleteTestDb(db);
	});

	it('fails closed when no keystore is initialized', async () => {
		const db = await openTestDb(); // deliberately NOT bootstrapped

		const store = createByokStore(db);
		await expect(store.saveApiKey(KEY)).rejects.toThrow(KeystoreNotInitializedError);
		await expect(store.readApiKey()).rejects.toThrow(KeystoreNotInitializedError);
		await deleteTestDb(db);
	});
});
