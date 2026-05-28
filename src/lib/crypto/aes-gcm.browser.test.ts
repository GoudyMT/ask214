import { describe, it, expect, beforeAll } from 'vitest';
import { aesGcmEncrypt, aesGcmDecrypt, AesGcmIvError, AesGcmAuthError } from './aes-gcm';

let testKey: CryptoKey;

beforeAll(async () => {
	testKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
		'encrypt',
		'decrypt'
	]);
});

describe('aesGcmEncrypt / aesGcmDecrypt', () => {
	const aad = new TextEncoder().encode('test|aad|field|values');
	const plaintext = new TextEncoder().encode('hello world');

	it('roundtrips plaintext through encrypt+decrypt with matching AAD', async () => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await aesGcmEncrypt(testKey, iv, aad, plaintext);
		const pt = await aesGcmDecrypt(testKey, iv, aad, ct);
		expect(new TextDecoder().decode(pt)).toBe('hello world');
	});

	it('throws AesGcmAuthError on AAD mismatch at decrypt', async () => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await aesGcmEncrypt(testKey, iv, aad, plaintext);
		const wrongAad = new TextEncoder().encode('test|aad|tampered|values');
		await expect(aesGcmDecrypt(testKey, iv, wrongAad, ct)).rejects.toThrow(AesGcmAuthError);
	});

	it('throws AesGcmAuthError on ciphertext mutation', async () => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await aesGcmEncrypt(testKey, iv, aad, plaintext);
		ct[0] = ((ct[0] ?? 0) + 1) & 0xff;
		await expect(aesGcmDecrypt(testKey, iv, aad, ct)).rejects.toThrow(AesGcmAuthError);
	});

	it('throws AesGcmIvError when IV is not 12 bytes (encrypt)', async () => {
		await expect(aesGcmEncrypt(testKey, new Uint8Array(11), aad, plaintext)).rejects.toThrow(
			AesGcmIvError
		);
		await expect(aesGcmEncrypt(testKey, new Uint8Array(16), aad, plaintext)).rejects.toThrow(
			AesGcmIvError
		);
	});

	it('throws AesGcmIvError when IV is not 12 bytes (decrypt)', async () => {
		const iv12 = crypto.getRandomValues(new Uint8Array(12));
		const ct = await aesGcmEncrypt(testKey, iv12, aad, plaintext);
		await expect(aesGcmDecrypt(testKey, new Uint8Array(11), aad, ct)).rejects.toThrow(
			AesGcmIvError
		);
	});

	it('accepts empty AAD (Uint8Array of length 0)', async () => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const emptyAad = new Uint8Array(0);
		const ct = await aesGcmEncrypt(testKey, iv, emptyAad, plaintext);
		const pt = await aesGcmDecrypt(testKey, iv, emptyAad, ct);
		expect(new TextDecoder().decode(pt)).toBe('hello world');
	});

	it('reports AesGcmIvError (not AuthError) when IV is wrong length AND ciphertext is tampered', async () => {
		// Locks the assert-before-try ordering: the IV-length check must win over
		// the auth failure, so a future refactor moving the assert inside the try
		// (which would mis-report as AesGcmAuthError) is caught here.
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await aesGcmEncrypt(testKey, iv, aad, plaintext);
		ct[0] = ((ct[0] ?? 0) + 1) & 0xff;
		await expect(aesGcmDecrypt(testKey, new Uint8Array(11), aad, ct)).rejects.toThrow(
			AesGcmIvError
		);
	});

	it('roundtrips empty plaintext', async () => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const empty = new Uint8Array(0);
		const ct = await aesGcmEncrypt(testKey, iv, aad, empty);
		const pt = await aesGcmDecrypt(testKey, iv, aad, ct);
		expect(pt.length).toBe(0);
	});

	it('throws AesGcmAuthError when decrypting with a different key', async () => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await aesGcmEncrypt(testKey, iv, aad, plaintext);
		const otherKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
			'encrypt',
			'decrypt'
		]);
		await expect(aesGcmDecrypt(otherKey, iv, aad, ct)).rejects.toThrow(AesGcmAuthError);
	});
});
