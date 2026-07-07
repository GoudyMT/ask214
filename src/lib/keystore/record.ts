import { hmacSign, hmacVerify } from '../crypto/hmac';

/**
 * Single HMAC-authenticated keystore record - all security-sensitive crypto
 * metadata in one place; tampering any covered field invalidates the record
 * HMAC at boot. v1.0 ships local mode only (passphrase modes deferred to v1.1).
 *
 * CryptoKey refs are stored via IDB structured-clone (extractable:false) and are
 * not serialized into the canonical form (SubtleCrypto does not expose key bytes).
 */
export type KeystoreRecordV1 = {
	v: 1;
	mode: 'local';
	keystoreGeneration: number;
	epoch: number; // forward-compat constant 0 in v1.0 (no rotation)
	ivCounter: number; // warn 2^28, hard-stop 2^32 - 2^24
	installUuid: Uint8Array; // 16 bytes
	dataKeyRef: CryptoKey; // AES-GCM-256, extractable:false
	hmacKeyRef: CryptoKey; // HMAC-SHA-256, extractable:false (domain-separation prefixes)
	recordHmac?: ArrayBuffer;
};

/**
 * Subset of the record covered by the record HMAC and the AAD
 * keystoreRecordHash. Excludes ivCounter (operational), recordHmac (self-
 * reference), and the CryptoKey refs (unserializable).
 */
export type KeystoreCanonicalInput = Omit<
	KeystoreRecordV1,
	'dataKeyRef' | 'hmacKeyRef' | 'recordHmac'
>;

const KEYSTORE_HMAC_PREFIX = 'mtc-v1|keystore-record|';

function canonicalString(r: KeystoreCanonicalInput): string {
	return [
		`v=${r.v}`,
		`mode=${r.mode}`,
		`keystoreGeneration=${r.keystoreGeneration}`,
		`epoch=${r.epoch}`,
		`installUuid=${byteHex(r.installUuid)}`
	].join('\n');
}

/**
 * Canonical bytes of the keystore record (excluding ivCounter, recordHmac, and
 * key refs). Shared by computeRecordHmac and the AAD keystoreRecordHash (F).
 */
export function canonicalizeKeystore(r: KeystoreCanonicalInput): Uint8Array {
	return new TextEncoder().encode(canonicalString(r));
}

/**
 * Prefixed canonical bytes that BOTH sign and verify run over. The NIST SP
 * 800-108-style domain-separation prefix is part of the MAC input, so a
 * keystore-record MAC can never validate against sidecar/broadcast canonical
 * bytes of the same shape.
 */
function recordHmacInput(r: KeystoreCanonicalInput): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(KEYSTORE_HMAC_PREFIX + canonicalString(r));
}

export function computeRecordHmac(
	r: KeystoreCanonicalInput,
	hmacKey: CryptoKey
): Promise<ArrayBuffer> {
	return hmacSign(hmacKey, recordHmacInput(r));
}

/**
 * Verify half of computeRecordHmac (constant-time via subtle.verify). Consumed
 * by ProfileStore.load for the fail-closed keystore-record integrity check.
 */
export function verifyRecordHmac(
	r: KeystoreCanonicalInput,
	hmacKey: CryptoKey,
	mac: ArrayBuffer
): Promise<boolean> {
	return hmacVerify(hmacKey, recordHmacInput(r), mac);
}

function byteHex(b: Uint8Array): string {
	return Array.from(b)
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');
}
