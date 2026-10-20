import { describe, it, expect } from 'vitest';
import {
	MAX_CIPHERTEXT_BYTES,
	MAX_DATA_B64_CHARS,
	ENVELOPE_FIXED_BYTES,
	FILE_SLACK_BYTES,
	MAX_FILE_BYTES
} from './caps';
import { serializeEnvelope } from './envelope-json';

function b64OfZeros(bytes: number): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

describe('backup caps', () => {
	it('derived numbers', () => {
		expect(MAX_CIPHERTEXT_BYTES).toBe(6_291_472);
		expect(MAX_DATA_B64_CHARS).toBe(8_388_632);
		expect(FILE_SLACK_BYTES).toBe(4096);

		// The real serializer with empty data and base64 of the real salt, iv and check lengths.
		const empty = serializeEnvelope({
			salt: b64OfZeros(16),
			iv: b64OfZeros(12),
			check: b64OfZeros(32),
			data: ''
		});
		expect(ENVELOPE_FIXED_BYTES).toBe(new TextEncoder().encode(empty).length);
		// Pinned: format v1 fixes the layout, so this number moves only with a format change, and then the file limit
		// must be re-derived on purpose.
		expect(ENVELOPE_FIXED_BYTES).toBe(243);

		expect(MAX_FILE_BYTES).toBe(ENVELOPE_FIXED_BYTES + MAX_DATA_B64_CHARS + FILE_SLACK_BYTES);
		expect(MAX_FILE_BYTES).toBe(8_392_971);
	});
});
