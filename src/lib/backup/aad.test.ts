import { describe, it, expect } from 'vitest';
import { buildBackupAad } from './aad';
import { KDF_V1, HKDF_INFO_V1, SALT_BYTES, IV_BYTES, CHECK_BYTES } from './kdf-params';

function counting(n: number, start = 0): Uint8Array {
	return Uint8Array.from({ length: n }, (_, i) => start + i);
}

describe('buildBackupAad', () => {
	it('the exact AAD string', () => {
		expect(buildBackupAad(counting(16), counting(12))).toBe(
			'ask214-backup|v1|argon2id;v=19;m=131072;t=4;p=2;len=32;salt=000102030405060708090a0b0c0d0e0f' +
				'|hkdf-sha256;info=ask214-backup-v1/aes-gcm-256|aes-256-gcm;iv=000102030405060708090a0b;tag=128'
		);
	});

	it('writes lowercase hex of every byte', () => {
		const aad = buildBackupAad(counting(16, 0xf0), counting(12, 0xab));
		expect(aad).toContain('salt=f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff|');
		expect(aad).toContain('iv=abacadaeafb0b1b2b3b4b5b6;');
	});

	it.each([
		['salt 15 bytes', 15, 12],
		['salt 17 bytes', 17, 12],
		['salt empty', 0, 12],
		['iv 11 bytes', 16, 11],
		['iv 13 bytes', 16, 13],
		['iv empty', 16, 0]
	])('a wrong length throws E_INTERNAL (%s)', (_name, saltLen, ivLen) => {
		expect(() => buildBackupAad(counting(saltLen), counting(ivLen))).toThrow('E_INTERNAL');
	});
});

describe('kdf-params', () => {
	it('pins the format v1 tuple and lengths', () => {
		expect(KDF_V1).toEqual({ v: 0x13, m: 131_072, t: 4, p: 2, dkLen: 32 });
		expect(Object.isFrozen(KDF_V1)).toBe(true);
		expect(HKDF_INFO_V1).toBe('ask214-backup-v1/aes-gcm-256');
		expect([SALT_BYTES, IV_BYTES, CHECK_BYTES]).toEqual([16, 12, 32]);
	});
});
