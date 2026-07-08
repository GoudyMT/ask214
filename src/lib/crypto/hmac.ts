/**
 * HMAC-SHA-256 sign + verify wrappers.
 *
 * Used by:
 * - KeystoreRecordV1.recordHmac
 * - SignedSidecar.mac
 * - BroadcastEnvelope.sig (v1.1, deferred)
 *
 * Key MUST be a non-extractable HMAC key with usages including
 * 'sign' (for hmacSign) or 'verify' (for hmacVerify).
 */

/**
 * Byte array backed by a (non-shared) ArrayBuffer - matches WebCrypto's
 * BufferSource requirement under TypeScript's typed-array generics (TS 5.7+).
 */
type Bytes = Uint8Array<ArrayBuffer>;

export async function hmacSign(key: CryptoKey, data: Bytes): Promise<ArrayBuffer> {
	return crypto.subtle.sign('HMAC', key, data);
}

export async function hmacVerify(
	key: CryptoKey,
	data: Bytes,
	signature: ArrayBuffer
): Promise<boolean> {
	return crypto.subtle.verify('HMAC', key, signature, data);
}
