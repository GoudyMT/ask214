import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../rules/no-input-in-error.js';

const ruleTester = new RuleTester({
	languageOptions: { ecmaVersion: 2024, sourceType: 'module' }
});

describe('mtc/no-input-in-error', () => {
	it('allows static error messages, forbids dynamic input in thrown Error messages', () => {
		expect(() =>
			ruleTester.run('no-input-in-error', rule, {
				valid: [
					{ code: "throw new EaosFormatError('format');" },
					{ code: "throw new EaosFormatError({ cause: 'format' });" },
					{ code: "throw new Error('static message');" },
					{ code: 'throw new Error(`static template`);' }
				],
				invalid: [
					{
						code: 'throw new EaosFormatError(`bad date: ${userInput}`);',
						errors: [{ messageId: 'noInterpolatedInput' }]
					},
					{
						code: 'throw new Error(input);',
						errors: [{ messageId: 'noRawIdentifierInput' }]
					},
					{
						code: "throw new Error('bad: ' + userInput);",
						errors: [{ messageId: 'noConcatInput' }]
					}
				]
			})
		).not.toThrow();
	});
});
