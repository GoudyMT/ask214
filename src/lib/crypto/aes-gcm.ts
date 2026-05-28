/**
 * AES-GCM-256 encrypt/decrypt wrapper with strict IV length + AAD discipline.
 *
 * IV: 12 bytes (96 bits); spec-mandated CSPRNG per call.
 * Tag length: 128 bits (default).
 * AAD: required; callers pass the AAD bytes per ProfileStore.buildAAD().
 *
 * Source: Phase 2 spec section 6 "AES-GCM encryption operation".
 */

const IV_LENGTH = 12;
const TAG_LENGTH_BITS = 128;

/**
 * Byte array backed by a (non-shared) ArrayBuffer - matches WebCrypto's
 * BufferSource requirement under TypeScript's typed-array generics (TS 5.7+).
 */
type Bytes = Uint8Array<ArrayBuffer>;

export class AesGcmIvError extends Error {
	constructor() {
		super('E_AES_GCM_IV_LENGTH');
		this.name = 'AesGcmIvError';
	}
}

export class AesGcmAuthError extends Error {
	constructor() {
		super('E_AES_GCM_AUTH');
		this.name = 'AesGcmAuthError';
	}
}

function assertIvLength(iv: Uint8Array): void {
	if (iv.length !== IV_LENGTH) throw new AesGcmIvError();
}

export async function aesGcmEncrypt(
	key: CryptoKey,
	iv: Bytes,
	aad: Bytes,
	plaintext: Bytes
): Promise<Bytes> {
	assertIvLength(iv);
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_LENGTH_BITS },
		key,
		plaintext
	);
	return new Uint8Array(ct);
}

export async function aesGcmDecrypt(
	key: CryptoKey,
	iv: Bytes,
	aad: Bytes,
	ciphertext: Bytes
): Promise<Bytes> {
	assertIvLength(iv);
	try {
		const pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_LENGTH_BITS },
			key,
			ciphertext
		);
		return new Uint8Array(pt);
	} catch {
		// SubtleCrypto throws OperationError for any auth failure (AAD mismatch,
		// ciphertext mutation, wrong key, wrong IV). Map to a typed error; never
		// include the original error message (PII risk per spec section 11).
		throw new AesGcmAuthError();
	}
}
