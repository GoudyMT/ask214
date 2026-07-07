import { aesGcmEncrypt, aesGcmDecrypt } from './aes-gcm';
import { buildAAD, computeKeystoreRecordHash } from '../profile/aad';
import type { KeystoreRecordV1 } from '../keystore/record';

/**
 * The single sanctioned, RECORD-AGNOSTIC encryption boundary (spec invariant 7).
 * Extracted from the profile-specific boundary so every encrypted store (profile,
 * timeline-state, ...) flows through ONE AES-GCM path.
 *
 * On-disk layout: [iv:12][ciphertext+tag]. No plaintext header - the caller's codec
 * owns any schemaVersion (checked AFTER AES-GCM auth). The 6-field AAD binds the
 * ciphertext to its store context, write generation, schema, and full keystore
 * state, so a relocated (different storeName/recordId), replayed (wrong generation),
 * or keystore-diverged record fails authentication.
 */
const IV_LENGTH = 12;

/** The store context an encrypted record is bound to via its AAD. */
export type RecordCtx = { storeName: string; recordId: string; schemaVersion: number };

async function buildRecordAad(
	ctx: RecordCtx,
	keystore: KeystoreRecordV1,
	generation: number
): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(
		buildAAD({
			storeName: ctx.storeName,
			recordId: ctx.recordId,
			keystoreGeneration: keystore.keystoreGeneration,
			generation,
			schemaVersion: ctx.schemaVersion,
			keystoreRecordHash: await computeKeystoreRecordHash(keystore)
		})
	);
}

/** Encrypt already-encoded plaintext bytes; returns the [iv][ct+tag] blob. */
export async function encryptRecord(
	ctx: RecordCtx,
	plaintext: Uint8Array,
	keystore: KeystoreRecordV1,
	generation: number
): Promise<Uint8Array> {
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	const aad = await buildRecordAad(ctx, keystore, generation);
	const ct = await aesGcmEncrypt(keystore.dataKeyRef, iv, aad, new Uint8Array(plaintext));

	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv, 0);
	out.set(ct, iv.length);
	return out;
}

/** Decrypt an [iv][ct+tag] blob bound to `ctx` + `expectedGeneration`; returns plaintext bytes. */
export async function decryptRecord(
	ctx: RecordCtx,
	blob: Uint8Array,
	keystore: KeystoreRecordV1,
	expectedGeneration: number
): Promise<Uint8Array> {
	const bytes = new Uint8Array(blob); // normalize to ArrayBuffer-backed (Bytes)
	const iv = bytes.subarray(0, IV_LENGTH);
	const ct = bytes.subarray(IV_LENGTH);
	const aad = await buildRecordAad(ctx, keystore, expectedGeneration);
	return aesGcmDecrypt(keystore.dataKeyRef, iv, aad, ct);
}
