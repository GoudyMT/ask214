import { describe, it, expect, beforeAll, vi } from 'vitest';
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

	// The decrypt mapping rests on this: an engine reports every authentication failure as an OperationError
	// DOMException, so that name alone separates "the bytes fail their check" from every other failure.
	describe('what the engine throws for bytes that fail their check', () => {
		const params = (iv: Uint8Array<ArrayBuffer>, additionalData: Uint8Array<ArrayBuffer>) => ({
			name: 'AES-GCM',
			iv,
			additionalData,
			tagLength: 128
		});

		async function engineError(run: () => Promise<unknown>): Promise<unknown> {
			try {
				await run();
			} catch (e) {
				return e;
			}
			throw new Error('PROBE_DID_NOT_REJECT');
		}

		it('is an OperationError for a flipped tag byte', async () => {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const ct = await aesGcmEncrypt(testKey, iv, aad, plaintext);
			ct[ct.length - 1] = ((ct[ct.length - 1] ?? 0) + 1) & 0xff;
			const e = await engineError(() => crypto.subtle.decrypt(params(iv, aad), testKey, ct));
			expect(e).toBeInstanceOf(DOMException);
			expect((e as DOMException).name).toBe('OperationError');
		});

		it.each([0, 1, 15])(
			'is an OperationError for a %i-byte ciphertext (shorter than the tag)',
			async (n) => {
				const iv = crypto.getRandomValues(new Uint8Array(12));
				const e = await engineError(() =>
					crypto.subtle.decrypt(params(iv, aad), testKey, new Uint8Array(n))
				);
				expect(e).toBeInstanceOf(DOMException);
				expect((e as DOMException).name).toBe('OperationError');
			}
		);

		it('is an OperationError for a different AAD', async () => {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const ct = await aesGcmEncrypt(testKey, iv, aad, plaintext);
			const wrong = new TextEncoder().encode('test|aad|tampered|values');
			const e = await engineError(() => crypto.subtle.decrypt(params(iv, wrong), testKey, ct));
			expect(e).toBeInstanceOf(DOMException);
			expect((e as DOMException).name).toBe('OperationError');
		});
	});

	// A failure that says nothing about the bytes (an engine that cannot run the algorithm, a bad argument) must not read
	// as damaged data: it carries a static code, never the engine's message, and is not an AesGcmAuthError.
	it.each([
		['a NotSupportedError', new DOMException('secret detail', 'NotSupportedError')],
		['an InvalidAccessError', new DOMException('secret detail', 'InvalidAccessError')],
		['a TypeError', new TypeError('secret detail')]
	])('throws the opaque decrypt code, not AesGcmAuthError, for %s', async (_, failure) => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await aesGcmEncrypt(testKey, iv, aad, plaintext);
		const spy = vi.spyOn(crypto.subtle, 'decrypt').mockRejectedValue(failure);
		try {
			const e = await aesGcmDecrypt(testKey, iv, aad, ct).catch((err: unknown) => err);
			expect(e).toBeInstanceOf(Error);
			expect(e).not.toBeInstanceOf(AesGcmAuthError);
			expect((e as Error).message).toBe('E_AES_GCM_DECRYPT');
		} finally {
			spy.mockRestore();
		}
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
