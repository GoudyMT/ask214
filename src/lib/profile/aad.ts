import { canonicalizeKeystore, type KeystoreCanonicalInput } from '../keystore/record';

/**
 * AAD (Additional Authenticated Data) binds AES-GCM profile ciphertext to its
 * context so a record cannot be silently relocated, downgraded, or replayed.
 * v1.0 AAD is 6 fields (dropped `userHandle` [single-user] and
 * `mode` [passphrase deferred]):
 *
 *   storeName | recordId | keystoreGeneration | generation | sv{schemaVersion} | <recordHashHex>
 *
 * - storeName + recordId: storage location
 * - keystoreGeneration:   keystore epoch
 * - generation:           per-record write counter (closes cross-generation replay)
 * - schemaVersion:        record format
 * - keystoreRecordHash:   fingerprint of the full keystore security state
 */
export type AADParams = {
	storeName: string;
	recordId: string;
	keystoreGeneration: number;
	generation: number;
	schemaVersion: number;
	keystoreRecordHash: Uint8Array;
};

export function buildAAD(p: AADParams): Uint8Array {
	const recordHashHex = Array.from(p.keystoreRecordHash)
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');
	const aad = [
		p.storeName,
		p.recordId,
		String(p.keystoreGeneration),
		String(p.generation),
		`sv${p.schemaVersion}`,
		recordHashHex
	].join('|');
	return new TextEncoder().encode(aad);
}

/**
 * SHA-256 over the canonical keystore bytes - the SAME canonical form as the
 * record HMAC, but with NO domain prefix (the `mtc-v1|keystore-record|` prefix
 * is HMAC-only). Gives the AAD a stable fingerprint of the keystore's security
 * state. `ivCounter` is already excluded by `canonicalizeKeystore` (operational,
 * not integrity-critical).
 */
export async function computeKeystoreRecordHash(
	record: KeystoreCanonicalInput
): Promise<Uint8Array> {
	// Fresh ArrayBuffer-backed copy so the bytes satisfy WebCrypto's BufferSource
	// (bare Uint8Array infers ArrayBufferLike under TS 5.7).
	const canonical = new Uint8Array(canonicalizeKeystore(record));
	const hash = await crypto.subtle.digest('SHA-256', canonical);
	return new Uint8Array(hash);
}
