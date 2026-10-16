import { serializeEnvelope } from './envelope-json';
import { SALT_BYTES, IV_BYTES, CHECK_BYTES } from './kdf-params';

/**
 * The longest task note, in UTF-16 code units (`String.length`). That is the unit an HTML `maxlength` counts, so the
 * note field, the timeline store and a backup file's validator all agree on exactly which notes are allowed.
 */
export const MAX_NOTE_UNITS = 100_000;

/**
 * The most plaintext one backup holds after padding. A multiple of the pad block, so a plaintext at or under this
 * number stays at or under it once padded, and the export can check the unpadded length.
 */
export const MAX_PADDED_PLAINTEXT_BYTES = 6 * 1024 * 1024;

/** The longest ciphertext: the padded plaintext plus the 16-byte GCM tag. */
export const MAX_CIPHERTEXT_BYTES = MAX_PADDED_PLAINTEXT_BYTES + 16;

/** The longest `data` field in base64 characters: four characters for every three bytes, rounded up. */
export const MAX_DATA_B64_CHARS = 4 * Math.ceil(MAX_CIPHERTEXT_BYTES / 3);

// Base64 length of n bytes, for sizing the placeholders below.
const b64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);

/**
 * The bytes of an envelope that are not `data`, measured on the real serializer so a change to the layout moves this
 * number with it instead of leaving a stale constant.
 */
export const ENVELOPE_FIXED_BYTES = new TextEncoder().encode(
	serializeEnvelope({
		salt: 'A'.repeat(b64Length(SALT_BYTES)),
		iv: 'A'.repeat(b64Length(IV_BYTES)),
		check: 'A'.repeat(b64Length(CHECK_BYTES)),
		data: ''
	})
).length;

/** Whitespace or a trailing newline a text tool may add to the file; `JSON.parse` accepts it. */
export const FILE_SLACK_BYTES = 4096;

/** The largest file the reader will look at; anything bigger is refused before it is read. */
export const MAX_FILE_BYTES = ENVELOPE_FIXED_BYTES + MAX_DATA_B64_CHARS + FILE_SLACK_BYTES;

/** The plaintext is padded to a multiple of this, so the ciphertext length hides the exact size of the data. */
export const PAD_BLOCK_BYTES = 4096;
