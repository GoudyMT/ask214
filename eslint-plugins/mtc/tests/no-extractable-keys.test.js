import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../rules/no-extractable-keys.js';

const ruleTester = new RuleTester({
	languageOptions: { ecmaVersion: 2024, sourceType: 'module' }
});

const ROTATE_FILE = 'src/lib/keystore/rotate.ts';
const OTHER_FILE = 'src/lib/other.ts';
const ROTATION = 'async function rotateToPin() { await subtle.generateKey(alg, true, u); }';

describe('mtc/no-extractable-keys', () => {
	// A key made extractable can be read out as raw bytes by any code running in the page, so app code asks for
	// non-extractable keys; only the one rotation function may make an extractable key, and it wraps it at once.
	it('allows non-extractable keys and the rotation function, refuses every other extractable key', () => {
		expect(() =>
			ruleTester.run('no-extractable-keys', rule, {
				valid: [
					{ code: 'crypto.subtle.generateKey(alg, false, u);' },
					{ code: "subtle.importKey('raw', k, alg, false, u);" },
					{ code: 'subtle.deriveKey(a, b, c, false, u);' },
					{ code: "subtle.unwrapKey('raw', w, k, a, b, false, u);" },
					{ code: 'subtle.exportKey(f, key);' },
					{ code: ROTATION, filename: ROTATE_FILE },
					{
						code: 'const rotateToPin = async () => { const make = () => subtle.importKey(f, k, a, true, u); await make(); };',
						filename: ROTATE_FILE
					},
					{
						code: 'const rotateToPin = async function () { await subtle.deriveKey(a, b, c, true, u); };',
						filename: ROTATE_FILE
					},
					// A Windows path to the same file.
					{ code: ROTATION, filename: 'C:\\repo\\src\\lib\\keystore\\rotate.ts' }
				],
				invalid: [
					{
						code: 'crypto.subtle.generateKey(alg, true, u);',
						errors: [{ messageId: 'extractableTrue' }]
					},
					{
						code: "subtle.importKey('raw', k, alg, true, u);",
						errors: [{ messageId: 'extractableTrue' }]
					},
					{
						code: 'subtle.deriveKey(a, b, c, true, u);',
						errors: [{ messageId: 'extractableTrue' }]
					},
					{
						code: "subtle.unwrapKey('raw', w, k, a, b, true, u);",
						errors: [{ messageId: 'extractableTrue' }]
					},
					// Truth passed through a variable is still truth.
					{
						code: "const x = true; subtle.importKey('raw', k, a, x, u);",
						errors: [{ messageId: 'extractableUnproven' }]
					},
					{
						code: 'subtle.generateKey(alg);',
						errors: [{ messageId: 'extractableUnproven' }]
					},
					{
						code: "subtle['generateKey'](alg, true, u);",
						errors: [{ messageId: 'extractableTrue' }]
					},
					{
						code: 'subtle?.generateKey(alg, true, u);',
						errors: [{ messageId: 'extractableTrue' }]
					},
					// A spread hides which value lands in the extractable position.
					{
						code: 'subtle.importKey(...args);',
						errors: [{ messageId: 'extractableUnproven' }]
					},
					// The exception is the one function in the one file.
					{ code: ROTATION, filename: OTHER_FILE, errors: [{ messageId: 'extractableTrue' }] },
					{
						code: 'async function rotate() { await subtle.generateKey(alg, true, u); }',
						filename: ROTATE_FILE,
						errors: [{ messageId: 'extractableTrue' }]
					},
					{
						code: 'async function rotateToPin() {} subtle.generateKey(alg, true, u);',
						filename: ROTATE_FILE,
						errors: [{ messageId: 'extractableTrue' }]
					}
				]
			})
		).not.toThrow();
	});
});
