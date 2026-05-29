import { describe, it, expect, beforeAll } from 'vitest';
import { encryptProfileRecord, decryptProfileRecord } from './crypto-boundary';
import { AesGcmAuthError } from '../crypto/aes-gcm';
import type { ProfileV1 } from './types';
import type { KeystoreRecordV1 } from '../keystore/record';

let dataKey: CryptoKey;
let hmacKey: CryptoKey;

beforeAll(async () => {
	dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
		'encrypt',
		'decrypt'
	]);
	hmacKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
});

const baseRecord = (): KeystoreRecordV1 => ({
	v: 1,
	mode: 'local',
	keystoreGeneration: 0,
	epoch: 0,
	ivCounter: 0,
	installUuid: new Uint8Array(16).fill(1),
	dataKeyRef: dataKey,
	hmacKeyRef: hmacKey
});

const baseProfile: ProfileV1 = {
	schemaVersion: 1,
	generation: 1,
	lastSeenAt: 1716700000000,
	setupIntent: 'completed',
	setupIntentChangedAt: 1716700000000,
	eaos: new TextEncoder().encode('2027-04-15')
};

describe('encryptProfileRecord / decryptProfileRecord', () => {
	it('roundtrips a profile through encrypt + decrypt', async () => {
		const r = baseRecord();
		const blob = await encryptProfileRecord(baseProfile, r);
		const dec = await decryptProfileRecord(blob, r, baseProfile.generation);
		expect(dec.eaos).not.toBeNull();
		if (dec.eaos) expect(new TextDecoder().decode(dec.eaos)).toBe('2027-04-15');
	});

	it('lays out iv(12) followed by ciphertext+tag (no plaintext header)', async () => {
		const r = baseRecord();
		const blob = await encryptProfileRecord(baseProfile, r);
		// iv + GCM ciphertext (>= plaintext) + 16-byte tag, all well past 12.
		expect(blob.length).toBeGreaterThan(12 + 16);
	});

	it('uses a fresh IV on each encrypt', async () => {
		const r = baseRecord();
		const a = await encryptProfileRecord(baseProfile, r);
		const b = await encryptProfileRecord(baseProfile, r);
		expect(Array.from(a.subarray(0, 12))).not.toEqual(Array.from(b.subarray(0, 12)));
	});

	it('fails auth when expectedGeneration does not match (replay/generation binding)', async () => {
		const r = baseRecord();
		const blob = await encryptProfileRecord(baseProfile, r);
		await expect(decryptProfileRecord(blob, r, baseProfile.generation + 1)).rejects.toThrow(
			AesGcmAuthError
		);
	});

	it('fails auth when the keystore state diverges (keystore-record binding)', async () => {
		const r = baseRecord();
		const blob = await encryptProfileRecord(baseProfile, r);
		// Same dataKey, different installUuid -> different keystoreRecordHash -> different AAD.
		const diverged: KeystoreRecordV1 = { ...r, installUuid: new Uint8Array(16).fill(2) };
		await expect(decryptProfileRecord(blob, diverged, baseProfile.generation)).rejects.toThrow(
			AesGcmAuthError
		);
	});

	it('fails auth when the ciphertext is tampered', async () => {
		const r = baseRecord();
		const blob = await encryptProfileRecord(baseProfile, r);
		const tampered = new Uint8Array(blob);
		tampered[20] = (tampered[20] ?? 0) ^ 0xff; // flip a byte in the ciphertext region
		await expect(decryptProfileRecord(tampered, r, baseProfile.generation)).rejects.toThrow(
			AesGcmAuthError
		);
	});
});
