import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import rule, { ENCRYPTED_STORES_LITERAL } from '../rules/encrypted-store-registry.js';
import { ENCRYPTED_STORES } from '../../../src/lib/db/registry.ts';

const ruleTester = new RuleTester({
	languageOptions: { ecmaVersion: 2024, sourceType: 'module' }
});

describe('mtc/encrypted-store-registry', () => {
	it('guards exactly the registered stores, no more and no less', () => {
		// This rule is plain JS and cannot import the TypeScript registry, so it carries a hardcoded
		// copy. A store registered there but missing here keeps its ciphertext write silently
		// unguarded - and worse, its inline eslint-disable then reads as unused and gets stripped.
		// This assertion is the only thing coupling the two lists.
		expect([...ENCRYPTED_STORES_LITERAL].sort()).toEqual([...ENCRYPTED_STORES].sort());
	});

	it('forbids raw-IDB writes to encrypted stores; allows unencrypted-store writes', () => {
		expect(() =>
			ruleTester.run('encrypted-store-registry', rule, {
				valid: [
					{ code: "import { ENCRYPTED_STORES } from '$lib/db/registry';" },
					// Unencrypted stores (signed sidecars, keys) are not gated.
					{ code: "tx.objectStore('profile-hwm').put(sidecar);" },
					{ code: "tx.objectStore('timeline-state-hwm').put(sidecar);" },
					{ code: "tx.objectStore('calendar-sync-hwm').put(sidecar);" },
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
					},
					{
						code: "tx.objectStore('calendar-sync').put({ id: 0, rec });",
						errors: [{ messageId: 'writeUnsanctioned' }]
					},
					{
						code: "tx.objectStore('byok').put({ id: 0, rec });",
						errors: [{ messageId: 'writeUnsanctioned' }]
					}
				]
			})
		).not.toThrow();
	});
});
