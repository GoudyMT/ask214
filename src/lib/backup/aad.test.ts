import { describe, it, expect } from 'vitest';
import { buildBackupAad } from './aad';

function counting(n: number, start = 0): Uint8Array {
	return Uint8Array.from({ length: n }, (_, i) => start + i);
}

describe('buildBackupAad', () => {
	it('writes lowercase hex of every byte', () => {
		const aad = buildBackupAad(counting(16, 0xf0), counting(12, 0xab));
		expect(aad).toContain('salt=f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff|');
		expect(aad).toContain('iv=abacadaeafb0b1b2b3b4b5b6;');
	});

	it.each([
		['salt 15 bytes', 15, 12],
		['salt 17 bytes', 17, 12],
		['iv 11 bytes', 16, 11],
		['iv 13 bytes', 16, 13]
	])('a wrong length throws E_INTERNAL (%s)', (_name, saltLen, ivLen) => {
		expect(() => buildBackupAad(counting(saltLen), counting(ivLen))).toThrow('E_INTERNAL');
	});
});
