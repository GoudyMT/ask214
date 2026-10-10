import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { encryptProfileRecord, decryptProfileRecord } from './crypto-boundary';
import { ProfileSchemaError } from './codec';
import { encryptRecord } from '../crypto/record-crypto';
import { AesGcmAuthError } from '../crypto/aes-gcm';
import type { ProfileV1 } from './types';
import type { KeystoreRecordV1 } from '../keystore/record';

// Passthrough seams that record the byte buffers the boundary hands to its collaborators, so a test can
// look at them after the call: what the encoder returned, the copy given to the cipher, and what the
// decoder was given. Each also notes whether the buffer still held data when it was handed over (and, for
// the cipher, when encryption settled), which keeps "all zero afterwards" from passing on an empty buffer.
const seen = vi.hoisted(() => ({
	encoded: [] as Uint8Array[],
	encodedFull: [] as boolean[],
	cipherInput: [] as Uint8Array[],
	cipherInputFullAtCall: [] as boolean[],
	cipherInputFullAtSettle: [] as boolean[],
	decoderInput: [] as Uint8Array[],
	decoderInputFull: [] as boolean[]
}));
const hasData = (b: Uint8Array): boolean => b.some((x) => x !== 0);

// `$lib` aliases on purpose: a relative path here never applied to the module under test in this runner.
vi.mock('$lib/profile/codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('./codec')>();
	return {
		...real,
		encodeProfile: (p: ProfileV1) => {
			const out = real.encodeProfile(p);
			seen.encoded.push(out);
			seen.encodedFull.push(out.some((x) => x !== 0));
			return out;
		},
		decodeProfile: (b: Uint8Array) => {
			seen.decoderInput.push(b);
			seen.decoderInputFull.push(b.some((x) => x !== 0));
			return real.decodeProfile(b);
		}
	};
});

vi.mock('$lib/crypto/record-crypto', async (importOriginal) => {
	const real = await importOriginal<typeof import('../crypto/record-crypto')>();
	return {
		...real,
		encryptRecord: async (...args: Parameters<typeof real.encryptRecord>) => {
			const plaintext = args[1];
			seen.cipherInput.push(plaintext);
			seen.cipherInputFullAtCall.push(plaintext.some((x) => x !== 0));
			const out = await real.encryptRecord(...args);
			seen.cipherInputFullAtSettle.push(plaintext.some((x) => x !== 0));
			return out;
		}
	};
});

let dataKey: CryptoKey;
let hmacKey: CryptoKey;

beforeEach(() => {
	for (const list of Object.values(seen)) list.length = 0;
});

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

	// The plaintext JSON is the whole profile in one buffer. The decoded record carries its own copies, so
	// the buffer has no use once decoding ends, and a heap that keeps it keeps the profile.
	describe('plaintext buffers', () => {
		it('wipes the decrypted buffer once it has been decoded', async () => {
			const r = baseRecord();
			const blob = await encryptProfileRecord(baseProfile, r);

			const dec = await decryptProfileRecord(blob, r, baseProfile.generation);

			expect(seen.decoderInput).toHaveLength(1);
			expect(seen.decoderInputFull).toEqual([true]);
			expect(seen.decoderInput.every((b) => b.length > 0 && !hasData(b))).toBe(true);
			// The record handed back owns its bytes: wiping the buffer must not reach into it.
			expect(new TextDecoder().decode(dec.eaos ?? undefined)).toBe('2027-04-15');
		});

		it('wipes the decrypted buffer when decoding throws', async () => {
			const r = baseRecord();
			const wrongSchema = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2 }));
			const blob = await encryptRecord(
				{ storeName: 'profile', recordId: 'self', schemaVersion: 1 },
				wrongSchema,
				r,
				baseProfile.generation
			);

			await expect(decryptProfileRecord(blob, r, baseProfile.generation)).rejects.toThrow(
				ProfileSchemaError
			);

			expect(seen.decoderInput).toHaveLength(1);
			expect(seen.decoderInputFull).toEqual([true]);
			expect(seen.decoderInput.every((b) => b.length > 0 && !hasData(b))).toBe(true);
		});

		it('wipes the encoded profile and the copy given to the cipher once encryption is done', async () => {
			const r = baseRecord();

			await encryptProfileRecord(baseProfile, r);

			expect(seen.encoded).toHaveLength(1);
			expect(seen.cipherInput).toHaveLength(1);
			// They held the profile when the cipher was handed it, and still did when it finished, so the wipe
			// came after encryption and not before.
			expect(seen.encodedFull).toEqual([true]);
			expect(seen.cipherInputFullAtCall).toEqual([true]);
			expect(seen.cipherInputFullAtSettle).toEqual([true]);
			expect(seen.encoded.every((b) => b.length > 0 && !hasData(b))).toBe(true);
			expect(seen.cipherInput.every((b) => b.length > 0 && !hasData(b))).toBe(true);
			// The caller's own profile is not the boundary's to wipe.
			expect(new TextDecoder().decode(baseProfile.eaos ?? undefined)).toBe('2027-04-15');
		});
	});
});
