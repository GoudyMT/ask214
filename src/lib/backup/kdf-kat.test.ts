import { argon2id } from '@noble/hashes/argon2.js';
import { describe, expect, it } from 'vitest';
import {
	KAT_ARGON2_TUPLE,
	KAT_PASSWORD,
	KAT_SALT,
	KAT_SMALL_ARGON2_HEX,
	RFC9106_ARGON2ID
} from './kdf-kat';
import { KDF_V1 } from './kdf-params';
import { canonicalizePhrase } from './phrase';
import { WORDS_V1 } from './words-v1';

// The same maxmem the worker passes: the v1 memory in bytes.
const MAXMEM = 134_217_728;
const SMALL = { t: 1, m: 64, p: 1, version: 0x13, dkLen: 32, maxmem: MAXMEM } as const;

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function passwordBytes(): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(KAT_PASSWORD);
}

describe('Argon2id known answers', () => {
	it('RFC 9106 Argon2id vector', () => {
		const out = argon2id(RFC9106_ARGON2ID.password, RFC9106_ARGON2ID.salt, {
			t: RFC9106_ARGON2ID.t,
			m: RFC9106_ARGON2ID.m,
			p: RFC9106_ARGON2ID.p,
			version: RFC9106_ARGON2ID.version,
			dkLen: RFC9106_ARGON2ID.dkLen,
			key: RFC9106_ARGON2ID.secret,
			personalization: RFC9106_ARGON2ID.associatedData
		});
		expect(hex(out)).toBe(RFC9106_ARGON2ID.tagHex);
	});

	it('the small-parameter independent vector', () => {
		const out = argon2id(passwordBytes(), KAT_SALT, { ...SMALL, onProgress: () => {} });
		expect(hex(out)).toBe(KAT_SMALL_ARGON2_HEX);
	});

	it('every KAT word is in WORDS_V1', () => {
		const words = KAT_PASSWORD.split(' ');
		expect(words).toHaveLength(6);
		for (const word of words) expect(WORDS_V1).toContain(word);
	});

	it('KAT_PASSWORD is the canonical form of itself', () => {
		const result = canonicalizePhrase(KAT_PASSWORD);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(hex(result.bytes)).toBe(hex(passwordBytes()));
	});

	it('the production KAT uses the v1 tuple', () => {
		expect(KAT_ARGON2_TUPLE).toEqual(KDF_V1);
	});
});
