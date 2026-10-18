import { describe, it, expect } from 'vitest';
import {
	MAX_PADDED_PLAINTEXT_BYTES,
	MAX_CIPHERTEXT_BYTES,
	MAX_DATA_B64_CHARS,
	ENVELOPE_FIXED_BYTES,
	FILE_SLACK_BYTES,
	MAX_FILE_BYTES,
	PAD_BLOCK_BYTES
} from './caps';
import { serializeEnvelope } from './envelope-json';
import { KDF_V1 } from './kdf-params';
import { MAX_NOTE_UNITS } from './note-cap';

function b64OfZeros(bytes: number): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

describe('backup caps', () => {
	it('the cap is a multiple of 4096', () => {
		expect(PAD_BLOCK_BYTES).toBe(4096);
		expect(MAX_PADDED_PLAINTEXT_BYTES % 4096).toBe(0);
		expect(MAX_PADDED_PLAINTEXT_BYTES).toBe(6_291_456);
	});

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

	it('the note cap is unchanged', () => {
		expect(MAX_NOTE_UNITS).toBe(100_000);
	});
});

describe('serializeEnvelope', () => {
	it('writes the keys in the format v1 order with no spaces', () => {
		expect(serializeEnvelope({ salt: 'SALT', iv: 'IV', check: 'CHECK', data: 'DATA' })).toBe(
			'{"format":"ask214-backup","version":1,"kdf":{"alg":"argon2id","v":19,"m":131072,"t":4,"p":2,' +
				'"salt":"SALT"},"cipher":{"alg":"AES-GCM","iv":"IV"},"check":"CHECK","data":"DATA"}'
		);
	});

	it('takes its numbers from KDF_V1', () => {
		const parsed = JSON.parse(serializeEnvelope({ salt: 'a', iv: 'b', check: 'c', data: 'd' })) as {
			kdf: { v: number; m: number; t: number; p: number };
		};
		expect(parsed.kdf).toEqual({
			alg: 'argon2id',
			v: KDF_V1.v,
			m: KDF_V1.m,
			t: KDF_V1.t,
			p: KDF_V1.p,
			salt: 'a'
		});
	});
});
