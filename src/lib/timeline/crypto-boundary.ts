import { encryptRecord, decryptRecord, type RecordCtx } from '../crypto/record-crypto';
import { encodeTimelineState, decodeTimelineState } from './state-codec';
import type { TimelineState } from './types';
import type { KeystoreRecordV1 } from '../keystore/record';

/**
 * The timeline-state encryption boundary - a thin wrapper over the record-agnostic crypto core
 * (`src/lib/crypto/record-crypto.ts`), shaped like the profile's. The store and any other writer of
 * this record go through this pair, so the record's AAD context lives in one place. schemaVersion
 * lives in the encrypted JSON and is checked by decodeTimelineState after authentication.
 */
const TIMELINE_CTX: RecordCtx = { storeName: 'timeline-state', recordId: 'self', schemaVersion: 1 };

export async function encryptTimelineRecord(
	state: TimelineState,
	keystore: KeystoreRecordV1,
	generation: number
): Promise<Uint8Array> {
	const encoded = encodeTimelineState(state);
	const plaintext = new Uint8Array(encoded);
	try {
		// Awaited inside the try: the wipe below must wait for the cipher to finish with the buffer.
		return await encryptRecord(TIMELINE_CTX, plaintext, keystore, generation);
	} finally {
		// Every status and note as JSON, in two buffers. The cipher keeps its own copy and the ciphertext
		// is all that is stored, so neither has a use once encryption ends.
		encoded.fill(0);
		plaintext.fill(0);
	}
}

export async function decryptTimelineRecord(
	blob: Uint8Array,
	keystore: KeystoreRecordV1,
	generation: number
): Promise<TimelineState> {
	const plaintext = await decryptRecord(TIMELINE_CTX, blob, keystore, generation);
	try {
		return decodeTimelineState(plaintext);
	} finally {
		// The decoded state owns its own strings, so this buffer is spent on success and on a schema
		// error alike. (Strings JSON.parse made from it cannot be overwritten; that much stays.)
		plaintext.fill(0);
	}
}
