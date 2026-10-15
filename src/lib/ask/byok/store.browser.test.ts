import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createByokStore } from './store';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { KeystoreNotInitializedError } from '$lib/profile/store.svelte';
import { withStores, reqToPromise } from '$lib/db/schema';
import { openTestDb, deleteTestDb } from '$lib/db/_test-helpers';

// Real Chromium (SubtleCrypto + IndexedDB). The byok store persists the user's BYO API key as a single
// encrypted self-row through the shared record-crypto boundary (AES-GCM under the keystore dataKeyRef).
// No HWM/OCC and no in-memory caching: the key is read-decrypted on demand and never held resident.

const KEY = 'sk-ant-api03-test-abc123XYZ';

// Passthrough seams over the cipher that keep the byte buffers the store hands over and gets back, so a
// test can look at them after the call. Each also notes whether the buffer held data at that moment,
// which keeps "all zero afterwards" from passing on a buffer that was empty from the start.
const seen = vi.hoisted(() => ({
	cipherInput: [] as Uint8Array[],
	cipherInputFullAtSettle: [] as boolean[],
	cipherOutput: [] as Uint8Array[],
	cipherOutputFull: [] as boolean[],
	failEncrypt: false
}));
const hasData = (b: Uint8Array): boolean => b.some((x) => x !== 0);

// `$lib` aliases on purpose: a relative path never applied to the module under test in this runner.
vi.mock('$lib/crypto/record-crypto', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/crypto/record-crypto')>();
	return {
		...real,
		encryptRecord: async (...args: Parameters<typeof real.encryptRecord>) => {
			const plaintext = args[1];
			seen.cipherInput.push(plaintext);
			if (seen.failEncrypt) {
				seen.cipherInputFullAtSettle.push(hasData(plaintext));
				throw new Error('E_TEST_ENCRYPT');
			}
			const out = await real.encryptRecord(...args);
			seen.cipherInputFullAtSettle.push(hasData(plaintext));
			return out;
		},
		decryptRecord: async (...args: Parameters<typeof real.decryptRecord>) => {
			const out = await real.decryptRecord(...args);
			seen.cipherOutput.push(out);
			seen.cipherOutputFull.push(hasData(out));
			return out;
		}
	};
});

beforeEach(() => {
	seen.cipherInput.length = 0;
	seen.cipherInputFullAtSettle.length = 0;
	seen.cipherOutput.length = 0;
	seen.cipherOutputFull.length = 0;
	seen.failEncrypt = false;
});

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

	// Run on a database with no keystore: a refusal that comes first throws its own code, one that reads the
	// keystore first would throw KeystoreNotInitializedError instead.
	it('saveApiKey refuses a bad shape and writes nothing', async () => {
		const db = await openTestDb();

		await expect(createByokStore(db).saveApiKey('apple harbor cable dog echo fox')).rejects.toThrow(
			'E_KEY_SHAPE'
		);
		expect(seen.cipherInput).toHaveLength(0);

		await bootstrapLocalKeystore(db);
		await expect(createByokStore(db).saveApiKey('sk-test-key')).rejects.toThrow('E_KEY_SHAPE');
		const row = await withStores(db, 'byok', 'readonly', (tx) =>
			reqToPromise<unknown>(tx.objectStore('byok').get(0))
		);
		expect(row).toBeUndefined();
		expect(seen.cipherInput).toHaveLength(0);
		await deleteTestDb(db);
	});
});

// A peer holding a lock: `hold(...)` resolves once the peer holds it, and `release` frees it and waits for it to go.
async function hold(name: string, mode: LockMode): Promise<{ release: () => Promise<void> }> {
	let release: () => void = () => {};
	let holding: Promise<void> = Promise.resolve();
	const granted = new Promise<void>((resolve) => {
		holding = navigator.locks.request(name, { mode }, async () => {
			await new Promise<void>((r) => {
				release = r;
				resolve();
			});
		});
	});
	await granted;
	return {
		release: async () => {
			release();
			await holding;
		}
	};
}

/** What a promise did, without hanging the test when it does nothing. */
async function outcomeOf(p: Promise<unknown>): Promise<unknown> {
	const settled = p.then(
		() => 'resolved' as const,
		(err: unknown) => err
	);
	const pending = new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 300));
	return Promise.race([settled, pending]);
}

const byokRow = (db: IDBDatabase) =>
	withStores(db, 'byok', 'readonly', (tx) => reqToPromise<unknown>(tx.objectStore('byok').get(0)));

// The device erase takes the keystore lock exclusive. A save or a remove that ran without the lock could land after
// the erase and write the key back into the emptied database; under the lock it runs wholly before or after it.
describe('byok store against an erase', () => {
	let db: IDBDatabase;

	beforeEach(async () => {
		db = await openTestDb();
		await bootstrapLocalKeystore(db);
	});

	afterEach(async () => {
		await deleteTestDb(db);
	});

	it('a key save straddling an Erase writes nothing', async () => {
		const peer = await hold('mtc-keystore', 'exclusive');
		let save: Promise<void> | undefined;
		try {
			save = createByokStore(db).saveApiKey(KEY);
			expect(await outcomeOf(save)).toBe('still waiting');
			expect(await byokRow(db)).toBeUndefined();
		} finally {
			await peer.release();
		}
		await save;
		expect(await byokRow(db)).toBeDefined();
		expect(await createByokStore(db).readApiKey()).toBe(KEY);
	});

	it('a key removal straddling an Erase waits for it', async () => {
		const store = createByokStore(db);
		await store.saveApiKey(KEY);
		const peer = await hold('mtc-keystore', 'exclusive');
		let clear: Promise<void> | undefined;
		try {
			clear = store.clearApiKey();
			expect(await outcomeOf(clear)).toBe('still waiting');
			expect(await byokRow(db)).toBeDefined();
		} finally {
			await peer.release();
		}
		await clear;
		expect(await byokRow(db)).toBeUndefined();
	});
});

describe('byok store plaintext buffers', () => {
	let db: IDBDatabase;

	beforeEach(async () => {
		db = await openTestDb();
		await bootstrapLocalKeystore(db);
	});

	afterEach(async () => {
		await deleteTestDb(db);
	});

	it('zeroes the encoded key once saveApiKey has encrypted it', async () => {
		await createByokStore(db).saveApiKey(KEY);
		expect(seen.cipherInput).toHaveLength(1);
		const [encoded] = seen.cipherInput;
		// Still the key while the cipher ran, and no longer once the save is over.
		expect(seen.cipherInputFullAtSettle).toEqual([true]);
		expect(encoded?.every((x) => x === 0)).toBe(true);
	});

	it('zeroes the encoded key when the encryption fails', async () => {
		seen.failEncrypt = true;
		await expect(createByokStore(db).saveApiKey(KEY)).rejects.toThrow('E_TEST_ENCRYPT');
		expect(seen.cipherInput).toHaveLength(1);
		expect(seen.cipherInputFullAtSettle).toEqual([true]);
		expect(seen.cipherInput[0]?.every((x) => x === 0)).toBe(true);
	});

	it('zeroes the decrypted bytes once readApiKey has decoded them, and still returns the key', async () => {
		const store = createByokStore(db);
		await store.saveApiKey(KEY);
		expect(await store.readApiKey()).toBe(KEY);
		expect(seen.cipherOutput).toHaveLength(1);
		expect(seen.cipherOutputFull).toEqual([true]);
		expect(seen.cipherOutput[0]?.every((x) => x === 0)).toBe(true);
	});
});
