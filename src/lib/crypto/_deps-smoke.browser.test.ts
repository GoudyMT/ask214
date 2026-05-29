import { describe, it, expect } from 'vitest';

// Canary: proves native Web Crypto is available (so v1.0 needs ZERO crypto
// dependencies) AND that the client/Chromium Vitest browser project runs locally
// before the real AES-GCM / HMAC tests depend on it.
describe('native Web Crypto is available (zero crypto dependencies)', () => {
	it('exposes crypto.subtle', () => {
		expect(typeof crypto.subtle.generateKey).toBe('function');
	});

	it('exposes crypto.getRandomValues', () => {
		const bytes = crypto.getRandomValues(new Uint8Array(4));
		expect(bytes.length).toBe(4);
	});

	it('generates a non-extractable AES-GCM-256 key', async () => {
		const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
			'encrypt',
			'decrypt'
		]);
		expect(key.type).toBe('secret');
		expect(key.extractable).toBe(false);
	});
});
