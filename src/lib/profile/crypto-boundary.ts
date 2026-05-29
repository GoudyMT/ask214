import { aesGcmEncrypt, aesGcmDecrypt } from '../crypto/aes-gcm';
import { encodeProfile, decodeProfile } from './codec';
import { buildAAD, computeKeystoreRecordHash } from './aad';
import type { ProfileV1 } from './types';
import type { KeystoreRecordV1 } from '../keystore/record';

/**
 * The single sanctioned profile encryption boundary (spec section 4 invariant 3).
 *
 * On-disk record layout: [iv:12][ciphertext+tag]. There is NO plaintext header -
 * schemaVersion lives inside the encrypted JSON (codec) and is checked by
 * decodeProfile AFTER AES-GCM authentication (plan v2 T3-A: no magic bytes, no
 * at-rest fingerprint). The 6-field AAD binds the ciphertext to its storage
 * location, write generation, schema, and full keystore state, so a relocated,
 * replayed, or keystore-diverged record fails authentication.
 *
 * Source: Phase 2 spec sections 4-5; plan v2 T3-A + T3-B.
 */
const IV_LENGTH = 12;
const STORE_NAME = 'profile';
const RECORD_ID = 'self';
const SCHEMA_VERSION = 1;

async function buildProfileAad(
	keystore: KeystoreRecordV1,
	generation: number,
	schemaVersion: number
): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(
		buildAAD({
			storeName: STORE_NAME,
			recordId: RECORD_ID,
			keystoreGeneration: keystore.keystoreGeneration,
			generation,
			schemaVersion,
			keystoreRecordHash: await computeKeystoreRecordHash(keystore)
		})
	);
}

export async function encryptProfileRecord(
	profile: ProfileV1,
	keystore: KeystoreRecordV1
): Promise<Uint8Array> {
	const plaintext = new Uint8Array(encodeProfile(profile));
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	// Bind the schema-version CONSTANT (same source decrypt uses), so encrypt and
	// decrypt can never drift on this AAD field at a future schema bump.
	const aad = await buildProfileAad(keystore, profile.generation, SCHEMA_VERSION);
	const ct = await aesGcmEncrypt(keystore.dataKeyRef, iv, aad, plaintext);

	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv, 0);
	out.set(ct, iv.length);
	return out;
}

export async function decryptProfileRecord(
	blob: Uint8Array,
	keystore: KeystoreRecordV1,
	expectedGeneration: number
): Promise<ProfileV1> {
	const bytes = new Uint8Array(blob); // normalize to ArrayBuffer-backed (Bytes)
	const iv = bytes.subarray(0, IV_LENGTH);
	const ct = bytes.subarray(IV_LENGTH);
	const aad = await buildProfileAad(keystore, expectedGeneration, SCHEMA_VERSION);
	const pt = await aesGcmDecrypt(keystore.dataKeyRef, iv, aad, ct);
	return decodeProfile(pt);
}
