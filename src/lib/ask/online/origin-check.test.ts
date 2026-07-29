import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from './origin-check';

describe('isAllowedOrigin', () => {
	it('accepts an allowed app origin', () => {
		expect(isAllowedOrigin('https://ask214.com', ['https://ask214.com'])).toBe(true);
	});
	it('rejects a foreign origin', () => {
		expect(isAllowedOrigin('https://evil.example', ['https://ask214.com'])).toBe(false);
	});
	it('rejects a missing Origin header (null)', () => {
		expect(isAllowedOrigin(null, ['https://ask214.com'])).toBe(false);
	});
	it('rejects when the allow-list is empty (fail closed on misconfig)', () => {
		expect(isAllowedOrigin('https://ask214.com', [])).toBe(false);
	});
});
