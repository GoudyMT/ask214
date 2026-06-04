import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../rules/encrypted-store-registry.js';

const ruleTester = new RuleTester({
	languageOptions: { ecmaVersion: 2024, sourceType: 'module' }
});

describe('mtc/encrypted-store-registry', () => {
	it('forbids raw-IDB writes to encrypted stores; allows unencrypted-store writes', () => {
		expect(() =>
			ruleTester.run('encrypted-store-registry', rule, {
				valid: [
					{ code: "import { ENCRYPTED_STORES } from '$lib/db/registry';" },
					// Unencrypted stores (signed sidecars, keys) are not gated.
					{ code: "tx.objectStore('profile-hwm').put(sidecar);" },
					{ code: "tx.objectStore('timeline-state-hwm').put(sidecar);" },
					{ code: "tx.objectStore('keystore').put(record);" }
				],
				invalid: [
					{
						code: "tx.objectStore('profile').put({ id: 0, rec });",
						errors: [{ messageId: 'writeUnsanctioned' }]
					},
					{
						code: "tx.objectStore('profile').add(item);",
						errors: [{ messageId: 'writeUnsanctioned' }]
					},
					{
						code: "tx.objectStore('timeline-state').put({ id: 0, rec });",
						errors: [{ messageId: 'writeUnsanctioned' }]
					}
				]
			})
		).not.toThrow();
	});
});
