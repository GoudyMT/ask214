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

function identityString(id: KeyIdentity): string {
	return [
		`v=${id.v}`,
		'mode=local',
		`keystoreGeneration=${id.keystoreGeneration}`,
		`epoch=${id.epoch}`,
		`installUuid=${byteHex(id.installUuid)}`
	].join('\n');
}

/**
 * Canonical bytes of the keystore record (excluding ivCounter, recordHmac, and
 * key refs). Shared by computeRecordHmac and the AAD keystoreRecordHash (F).
 */
export function canonicalizeKeystore(r: KeystoreCanonicalInput): Uint8Array {
	return keyIdentityBytes(keyIdentity(r));
}

/**
 * Prefixed canonical bytes that BOTH sign and verify run over. The NIST SP
 * 800-108-style domain-separation prefix is part of the MAC input, so a
 * keystore-record MAC can never validate against sidecar/broadcast canonical
 * bytes of the same shape.
 */
function recordHmacInput(r: KeystoreCanonicalInput): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(KEYSTORE_HMAC_PREFIX + identityString(r));
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

/** What binds every encrypted record to its keystore (the AAD's keystore fingerprint). */
export type KeyIdentity = Readonly<{
	v: 1;
	keystoreGeneration: number;
	epoch: number;
	installUuid: Uint8Array;
}>;

export function keyIdentity(row: KeystoreCanonicalInput): KeyIdentity {
	return {
		v: row.v,
		keystoreGeneration: row.keystoreGeneration,
		epoch: row.epoch,
		installUuid: row.installUuid
	};
}

/**
 * Exactly today's canonical bytes. The mode is the frozen literal `local` and not a
 * field of the identity, so a later change of lock mode never moves a stored record's AAD.
 */
export function keyIdentityBytes(id: KeyIdentity): Uint8Array {
	return new TextEncoder().encode(identityString(id));
}

/** The keys a tab may use with a row. In local mode the row's own HMAC key signs the row. */
export type KeystoreKeys = Readonly<{
	dataKey: CryptoKey;
	hmacKey: CryptoKey;
	bootstrapMacKey: CryptoKey;
}>;

/** The keystore record MAC. Local mode: the row's canonical bytes under its own HMAC key. */
export function signKeystore(
	row: KeystoreCanonicalInput,
	keys: KeystoreKeys
): Promise<ArrayBuffer> {
	return computeRecordHmac(row, keys.bootstrapMacKey);
}

/** False when the row has no recordHmac or the MAC does not verify. */
export async function verifyKeystore(
	row: KeystoreCanonicalInput & { recordHmac?: ArrayBuffer },
	keys: KeystoreKeys
): Promise<boolean> {
	if (!row.recordHmac) return false;
	return verifyRecordHmac(row, keys.bootstrapMacKey, row.recordHmac);
}

function byteHex(b: Uint8Array): string {
	return Array.from(b)
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');
}
