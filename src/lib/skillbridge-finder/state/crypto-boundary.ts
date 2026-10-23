import { encryptRecord, decryptRecord, type RecordCtx } from '../../crypto/record-crypto';
import { encodeFinderRecord, decodeFinderRecord } from './codec';
import type { FinderRecord } from './types';
import type { KeystoreRecordV1 } from '../../keystore/record';

/**
 * The finder record's encryption boundary - a thin wrapper over the record-agnostic crypto core
 * (`src/lib/crypto/record-crypto.ts`), shaped like the calendar's. The store and any other writer of this record go
 * through this pair, so the record's AAD context lives in one place. schemaVersion lives in the encrypted JSON and is
 * checked by decodeFinderRecord after authentication.
 */
const FINDER_CTX: RecordCtx = {
	storeName: 'skillbridge-finder',
	recordId: 'self',
	schemaVersion: 1
};

export async function encryptFinderRecord(
	record: FinderRecord,
	keystore: KeystoreRecordV1,
	generation: number
): Promise<Uint8Array> {
	const encoded = encodeFinderRecord(record);
	const plaintext = new Uint8Array(encoded);
	try {
		// Awaited inside the try: the wipe below must wait for the cipher to finish with the buffer.
		return await encryptRecord(FINDER_CTX, plaintext, keystore, generation);
	} finally {
		// The person's place, saved programs and filters as JSON, in two buffers. The cipher keeps its own copy and the
		// ciphertext is all that is stored, so neither has a use once encryption ends.
		encoded.fill(0);
		plaintext.fill(0);
	}
}

export async function decryptFinderRecord(
	blob: Uint8Array,
	keystore: KeystoreRecordV1,
	generation: number
): Promise<FinderRecord> {
	const plaintext = await decryptRecord(FINDER_CTX, blob, keystore, generation);
	try {
		return decodeFinderRecord(plaintext);
	} finally {
		// The decoded record owns its own strings, so this buffer is spent on success and on a schema error alike.
		// (Strings JSON.parse made from it cannot be overwritten; that much stays.)
		plaintext.fill(0);
	}
}
