import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrapLocalKeystore, KeystoreAlreadyExistsError } from './bootstrap';
import { computeRecordHmac } from './record';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import { withStores, reqToPromise } from '../db/schema';
import { verifySidecar, type SignedSidecar, type ProfileHwmPayload } from '../profile/sidecars';

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
});

afterEach(async () => {
	await deleteTestDb(db);
});

describe('bootstrapLocalKeystore', () => {
	it('creates a v1 local-mode record with 2 keys and no sidecar key', async () => {
		const { record } = await bootstrapLocalKeystore(db);
		expect(record.v).toBe(1);
		expect(record.mode).toBe('local');
		expect(record.keystoreGeneration).toBe(0);
		expect(record.epoch).toBe(0);
		expect(record.ivCounter).toBe(0);
		expect(record.installUuid).toBeInstanceOf(Uint8Array);
		expect(record.installUuid.length).toBe(16);
		expect(record.dataKeyRef).toBeDefined();
		expect(record.hmacKeyRef).toBeDefined();
		expect(record.recordHmac).toBeDefined();
		expect('sidecarMacKeyRef' in record).toBe(false);
	});

	it('generates non-extractable keys with the expected algorithms', async () => {
		const { record } = await bootstrapLocalKeystore(db);
		expect(record.dataKeyRef.extractable).toBe(false);
		expect(record.dataKeyRef.type).toBe('secret');
		expect((record.dataKeyRef.algorithm as AesKeyAlgorithm).name).toBe('AES-GCM');
		expect((record.dataKeyRef.algorithm as AesKeyAlgorithm).length).toBe(256);
		expect(record.hmacKeyRef.extractable).toBe(false);
		expect((record.hmacKeyRef.algorithm as HmacKeyAlgorithm).name).toBe('HMAC');
	});

	it('writes the keystore record durably (read back id=0, mode local)', async () => {
		await bootstrapLocalKeystore(db);
		const loaded = await withStores(db, 'keystore', 'readonly', (tx) =>
			reqToPromise<{ id: number; mode: string } | undefined>(tx.objectStore('keystore').get(0))
		);
		expect(loaded).toBeDefined();
		expect(loaded?.mode).toBe('local');
	});

	it('writes an initial profile-hwm sidecar that verifies under the single hmacKey', async () => {
		const { record } = await bootstrapLocalKeystore(db);
		const stored = await withStores(db, 'profile-hwm', 'readonly', (tx) =>
			reqToPromise<SignedSidecar<ProfileHwmPayload> | undefined>(
				tx.objectStore('profile-hwm').get(0)
			)
		);
		expect(stored).toBeDefined();
		const payload = await verifySidecar(
			'profile-hwm',
			stored as SignedSidecar<ProfileHwmPayload>,
			record.hmacKeyRef
		);
		expect(payload.generation).toBe(0);
		expect(payload.keystoreGeneration).toBe(0);
		expect(payload.epoch).toBe(0);
	});

	it('computes recordHmac correctly (recomputes-equal under the stored hmacKey)', async () => {
		const { record } = await bootstrapLocalKeystore(db);
		const recomputed = await computeRecordHmac(record, record.hmacKeyRef);
		expect(record.recordHmac).toBeDefined();
		expect(Array.from(new Uint8Array(record.recordHmac as ArrayBuffer))).toEqual(
			Array.from(new Uint8Array(recomputed))
		);
	});

	it('is idempotent: a second call rejects and leaves the original record intact', async () => {
		await bootstrapLocalKeystore(db);
		await expect(bootstrapLocalKeystore(db)).rejects.toThrow(KeystoreAlreadyExistsError);
		const loaded = await withStores(db, 'keystore', 'readonly', (tx) =>
			reqToPromise<{ mode: string } | undefined>(tx.objectStore('keystore').get(0))
		);
		expect(loaded?.mode).toBe('local');
	});
});
