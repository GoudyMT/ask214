import { describe, it, expect } from 'vitest';
import { encryptRecord, decryptRecord } from './record-crypto';
import { AesGcmAuthError } from './aes-gcm';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';

// The record-agnostic encryption boundary (extracted from the profile-specific
// crypto-boundary). Both `profile` and `timeline-state` flow through this ONE
// sanctioned AES-GCM path; the AAD binds `storeName`, so a record cannot be
// decrypted under a different store's context.

const CTX = { storeName: 'timeline-state', recordId: 'self', schemaVersion: 1 };

describe('record-crypto (generic boundary)', () => {
	it('round-trips arbitrary plaintext bound to a store context', async () => {
		const db = await openTestDb();
		const { record: ks } = await bootstrapLocalKeystore(db);
		const pt = new TextEncoder().encode('{"hello":"world"}');
		const blob = await encryptRecord(CTX, pt, ks, 1);
		const back = await decryptRecord(CTX, blob, ks, 1);
		expect(new TextDecoder().decode(back)).toBe('{"hello":"world"}');
		await deleteTestDb(db);
	});

	it('fails auth when the store context differs (AAD storeName binding)', async () => {
		const db = await openTestDb();
		const { record: ks } = await bootstrapLocalKeystore(db);
		const blob = await encryptRecord(CTX, new TextEncoder().encode('x'), ks, 1);
		await expect(decryptRecord({ ...CTX, storeName: 'profile' }, blob, ks, 1)).rejects.toThrow(
			AesGcmAuthError
		);
		await deleteTestDb(db);
	});
});
