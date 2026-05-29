import { describe, it, expect, beforeAll } from 'vitest';
import { hmacSign, hmacVerify } from './hmac';

let testKey: CryptoKey;

beforeAll(async () => {
	testKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
});

describe('hmacSign / hmacVerify', () => {
	const data = new TextEncoder().encode('payload');

	it('produces 32-byte signature for SHA-256', async () => {
		const sig = await hmacSign(testKey, data);
		expect(sig.byteLength).toBe(32);
	});

	it('is deterministic for same key + data', async () => {
		const a = await hmacSign(testKey, data);
		const b = await hmacSign(testKey, data);
		expect(Array.from(new Uint8Array(a))).toEqual(Array.from(new Uint8Array(b)));
	});

	it('verifies a valid signature', async () => {
		const sig = await hmacSign(testKey, data);
		expect(await hmacVerify(testKey, data, sig)).toBe(true);
	});

	it('rejects a tampered signature', async () => {
		const sig = await hmacSign(testKey, data);
		const tampered = new Uint8Array(sig);
		tampered[0] = ((tampered[0] ?? 0) + 1) & 0xff;
		expect(await hmacVerify(testKey, data, tampered.buffer)).toBe(false);
	});

	it('rejects a signature against different data', async () => {
		const sig = await hmacSign(testKey, data);
		const otherData = new TextEncoder().encode('different');
		expect(await hmacVerify(testKey, otherData, sig)).toBe(false);
	});

	it('rejects a signature against different key', async () => {
		const sig = await hmacSign(testKey, data);
		const otherKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
			'sign',
			'verify'
		]);
		expect(await hmacVerify(otherKey, data, sig)).toBe(false);
	});
});
