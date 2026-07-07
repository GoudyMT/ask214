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
	return encryptRecord(
		PROFILE_CTX,
		new Uint8Array(encodeProfile(profile)),
		keystore,
		profile.generation
	);
}

export async function decryptProfileRecord(
	blob: Uint8Array,
	keystore: KeystoreRecordV1,
	expectedGeneration: number
): Promise<ProfileV1> {
	return decodeProfile(await decryptRecord(PROFILE_CTX, blob, keystore, expectedGeneration));
}
