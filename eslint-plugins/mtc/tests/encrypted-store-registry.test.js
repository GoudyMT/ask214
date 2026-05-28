import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../rules/encrypted-store-registry.js';

const ruleTester = new RuleTester({
	languageOptions: { ecmaVersion: 2024, sourceType: 'module' }
});

describe('mtc/encrypted-store-registry', () => {
	it('allows registry reads + unencrypted-store writes, forbids direct encrypted-store writes', () => {
		expect(() =>
			ruleTester.run('encrypted-store-registry', rule, {
				valid: [
					{ code: "import { ENCRYPTED_STORES } from '$lib/db/registry';" },
					{ code: "await db.table('profile-hwm').put(sidecar);" },
					{
						code: "await db.transaction([profile, meta], 'rw', async () => { await profile.put(ct); });"
					}
				],
				invalid: [
					{
						code: "await db.table('profile').put({ ct: rawPlaintext });",
						errors: [{ messageId: 'writeUnsanctioned' }]
					},
					{
						code: "await db.table('profile').add(item);",
						errors: [{ messageId: 'writeUnsanctioned' }]
					}
				]
			})
		).not.toThrow();
	});
});
