import { describe, test, expect } from 'vitest';
import { sha256Hex } from './hash';

describe('sha256Hex', () => {
	test('hashes empty input to the known SHA-256 vector', async () => {
		const h = await sha256Hex(new Uint8Array());
		expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	test('returns 64 lowercase hex chars, deterministically', async () => {
		const a = await sha256Hex(new TextEncoder().encode('hello'));
		const b = await sha256Hex(new TextEncoder().encode('hello'));
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).toBe(b);
	});
});
