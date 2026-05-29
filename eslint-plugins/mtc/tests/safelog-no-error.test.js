import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../rules/safelog-no-error.js';

const ruleTester = new RuleTester({
	languageOptions: { ecmaVersion: 2024, sourceType: 'module' }
});

describe('mtc/safelog-no-error', () => {
	it('accepts safe safeLog calls and rejects Error-bearing ones', () => {
		expect(() =>
			ruleTester.run('safelog-no-error', rule, {
				valid: [
					{ code: "safeLog({ code: 'E_EAOS_FORMAT' });" },
					{ code: "safeLog({ code: 'E_EAOS_FORMAT', fields: { generation: 1 } });" },
					{ code: "safeLog({ code: 'E_TEST', fields: { ok: true } });" }
				],
				invalid: [
					{
						code: "safeLog({ code: 'E_X', fields: { err } });",
						errors: [{ messageId: 'noErrorInFields' }]
					},
					{
						code: "safeLog({ code: 'E_X', fields: { msg: error.message } });",
						errors: [{ messageId: 'noErrorMessageInFields' }]
					},
					{ code: 'safeLog(error);', errors: [{ messageId: 'noErrorArg' }] },
					{
						code: 'safeLog({ code: error.code });',
						errors: [{ messageId: 'noErrorPropertyInCode' }]
					}
				]
			})
		).not.toThrow();
	});
});
