import { describe, it, expect, vi } from 'vitest';
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

	// The IV only ever comes from the stored blob, so a blob too short to hold an IV and a tag is stored bytes that fail
	// their check - damage, never a wrong argument from the caller.
	it.each([
		['empty', new Uint8Array(0)],
		['shorter than an IV', new Uint8Array(11)],
		['an IV and a short tag', new Uint8Array(27)],
		['missing', undefined as unknown as Uint8Array],
		['not bytes', 'abc' as unknown as Uint8Array]
	])('treats a stored record that is %s as failing authentication', async (_, blob) => {
		const db = await openTestDb();
		const { record: ks } = await bootstrapLocalKeystore(db);
		await expect(decryptRecord(CTX, blob, ks, 1)).rejects.toThrow(AesGcmAuthError);
		await deleteTestDb(db);
	});

	it('reads a stored record of exactly an IV and a tag (an empty plaintext)', async () => {
		const db = await openTestDb();
		const { record: ks } = await bootstrapLocalKeystore(db);
		const empty = await encryptRecord(CTX, new Uint8Array(0), ks, 1);
		expect(empty.length).toBe(28);
		expect((await decryptRecord(CTX, empty, ks, 1)).length).toBe(0);
		await deleteTestDb(db);
	});

	// WebCrypto copies its input at the call, so the copy made for it holds the plaintext for nothing once it settles.
	it('zeroizes the plaintext copy it hands the cipher once it has settled', async () => {
		const db = await openTestDb();
		const { record: ks } = await bootstrapLocalKeystore(db);
		// A passthrough on the engine's encrypt: aesGcmEncrypt hands it the plaintext array unchanged, so the array it
		// is given here is the copy encryptRecord made.
		const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
		const seen: Uint8Array[] = [];
		const nonzeroAtCall: number[] = [];
		const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation((algorithm, key, data) => {
			const copy = data as Uint8Array;
			seen.push(copy);
			nonzeroAtCall.push(copy.reduce((n, b) => n + (b === 0 ? 0 : 1), 0));
			return realEncrypt(algorithm, key, data);
		});
		try {
			const input = new TextEncoder().encode('{"hello":"world"}');
			await encryptRecord(CTX, input, ks, 1);
			expect(seen.length).toBe(1);
			expect(seen[0]).not.toBe(input);
			expect(nonzeroAtCall[0]).toBe(input.length);
			expect(Array.from(seen[0] ?? [])).toEqual(new Array(input.length).fill(0));
			expect(new TextDecoder().decode(input)).toBe('{"hello":"world"}');
		} finally {
			spy.mockRestore();
		}
		await deleteTestDb(db);
	});
});
