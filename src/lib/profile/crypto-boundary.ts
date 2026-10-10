import { encryptRecord, decryptRecord, type RecordCtx } from '../crypto/record-crypto';
import { encodeProfile, decodeProfile } from './codec';
import type { ProfileV1 } from './types';
import type { KeystoreRecordV1 } from '../keystore/record';

/**
 * The profile encryption boundary - a thin wrapper over the record-agnostic crypto
 * core (`src/lib/crypto/record-crypto.ts`). On-disk layout + AAD are UNCHANGED from
 * the original profile-specific implementation ([iv:12][ct+tag], no plaintext header;
 * schemaVersion lives in the encrypted JSON and is checked by decodeProfile post-auth;
 * 6-field AAD binds location + write generation + schema + keystore state).
 */
const PROFILE_CTX: RecordCtx = { storeName: 'profile', recordId: 'self', schemaVersion: 1 };

export async function encryptProfileRecord(
	profile: ProfileV1,
	keystore: KeystoreRecordV1
): Promise<Uint8Array> {
	const encoded = encodeProfile(profile);
	const plaintext = new Uint8Array(encoded);
	try {
		// Awaited inside the try: the wipe below must wait for the cipher to finish with the buffer.
		return await encryptRecord(PROFILE_CTX, plaintext, keystore, profile.generation);
	} finally {
		// The whole profile as JSON, in two buffers. The cipher keeps its own copy and the ciphertext
		// is all that is stored, so neither has a use once encryption ends.
		encoded.fill(0);
		plaintext.fill(0);
	}
}

export async function decryptProfileRecord(
	blob: Uint8Array,
	keystore: KeystoreRecordV1,
	expectedGeneration: number
): Promise<ProfileV1> {
	const plaintext = await decryptRecord(PROFILE_CTX, blob, keystore, expectedGeneration);
	try {
		return decodeProfile(plaintext);
	} finally {
		// The decoded record owns copies of every byte field, so this buffer is spent on success and on a
		// schema error alike. (Strings JSON.parse made from it cannot be overwritten; that much stays.)
		plaintext.fill(0);
	}
}
