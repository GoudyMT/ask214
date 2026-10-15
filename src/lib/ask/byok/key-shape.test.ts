import { describe, it, expect } from 'vitest';
import { isAnthropicKeyShape } from './key-shape';

describe('isAnthropicKeyShape', () => {
	it('accepts a value that starts sk-ant- with no whitespace', () => {
		expect(isAnthropicKeyShape('sk-ant-api03-x')).toBe(true);
	});

	it('refuses a value with a space inside', () => {
		expect(isAnthropicKeyShape('sk-ant- x')).toBe(false);
	});

	it('refuses an empty value', () => {
		expect(isAnthropicKeyShape('')).toBe(false);
	});

	it('refuses six words, as a backup passphrase pasted in the wrong field', () => {
		expect(isAnthropicKeyShape('apple harbor cable dog echo fox')).toBe(false);
	});

	it('refuses a tab or a newline inside', () => {
		expect(isAnthropicKeyShape('sk-ant-a\tb')).toBe(false);
		expect(isAnthropicKeyShape('sk-ant-a\nb')).toBe(false);
	});

	it('refuses a value that does not start with the prefix', () => {
		expect(isAnthropicKeyShape('sk-test-key')).toBe(false);
		expect(isAnthropicKeyShape('xsk-ant-api03-x')).toBe(false);
	});
});
