import { encryptRecord, decryptRecord, type RecordCtx } from '../crypto/record-crypto';
import { encodeCalendarSyncState, decodeCalendarSyncState } from './codec';
import type { CalendarSyncState } from './types';
import type { KeystoreRecordV1 } from '../keystore/record';

/**
 * The calendar-sync encryption boundary - a thin wrapper over the record-agnostic crypto core
 * (`src/lib/crypto/record-crypto.ts`), shaped like the profile's. The store and any other writer of
 * this record go through this pair, so the record's AAD context lives in one place. schemaVersion
 * lives in the encrypted JSON and is checked by decodeCalendarSyncState after authentication.
 */
const CALENDAR_CTX: RecordCtx = { storeName: 'calendar-sync', recordId: 'self', schemaVersion: 1 };

export async function encryptCalendarRecord(
	state: CalendarSyncState,
	keystore: KeystoreRecordV1,
	generation: number
): Promise<Uint8Array> {
	const encoded = encodeCalendarSyncState(state);
	const plaintext = new Uint8Array(encoded);
	try {
		// Awaited inside the try: the wipe below must wait for the cipher to finish with the buffer.
		return await encryptRecord(CALENDAR_CTX, plaintext, keystore, generation);
	} finally {
		// The exclusions and handed-over events as JSON, in two buffers. The cipher keeps its own copy
		// and the ciphertext is all that is stored, so neither has a use once encryption ends.
		encoded.fill(0);
		plaintext.fill(0);
	}
}

export async function decryptCalendarRecord(
	blob: Uint8Array,
	keystore: KeystoreRecordV1,
	generation: number
): Promise<CalendarSyncState> {
	const plaintext = await decryptRecord(CALENDAR_CTX, blob, keystore, generation);
	try {
		return decodeCalendarSyncState(plaintext);
	} finally {
		// The decoded state owns its own strings, so this buffer is spent on success and on a schema
		// error alike. (Strings JSON.parse made from it cannot be overwritten; that much stays.)
		plaintext.fill(0);
	}
}
