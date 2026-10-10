import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import ts from 'typescript-eslint';
import rule, { ENCRYPTED_STORES_LITERAL } from '../rules/encrypted-store-registry.js';
import { ENCRYPTED_STORES } from '../../../src/lib/db/registry.ts';

const ruleTester = new RuleTester({
	languageOptions: { ecmaVersion: 2024, sourceType: 'module' }
});

/** Runs one planted snippet through the rule; RuleTester throws on a mismatch, which `expect` turns into a failure. */
function expectReported(code, languageOptions = {}) {
	expect(() =>
		ruleTester.run('encrypted-store-registry', rule, {
			valid: [],
			invalid: [{ code, languageOptions, errors: [{ messageId: 'writeUnsanctioned' }] }]
		})
	).not.toThrow();
}

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
					{ code: "tx.objectStore('keystore').put(record);" },
					// Reads and clears are not writes of ciphertext.
					{ code: "tx.objectStore('profile').get(0);" },
					{ code: "tx.objectStore('profile').clear();" },
					{ code: "const s = tx.objectStore('profile'); s.get(0); s.clear();" },
					{ code: "tx.objectStore('byok')['get'](0);" },
					// Other shapes of the same call stay allowed when the store is not encrypted.
					{ code: "const s = tx.objectStore('keystore'); s.put(record);" },
					{ code: "const S = 'keystore'; tx.objectStore(S).put(record);" },
					{ code: "tx.objectStore('keystore')['put'](record);" },
					// A store name known only at run time cannot be judged here; the literal shapes are the guard.
					{ code: 'tx.objectStore(name).put(record);' },
					{ code: 'var a = a; a.put(record);' },
					{ code: "let S = 'profile'; S = pick(); tx.objectStore(S).put(record);" }
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

	it('keeps a sanctioned write allowed by its inline disable, and that disable is used', () => {
		// The four sanctioned writes carry this comment. With unused directives an error, a rule that stopped
		// matching the chain would fail here as well as in the repo lint.
		expect(() =>
			ruleTester.run('encrypted-store-registry', rule, {
				valid: [
					{
						code: "// eslint-disable-next-line rule-to-test/encrypted-store-registry -- sanctioned\ntx.objectStore('profile').put({ id: 0, rec });",
						linterOptions: { reportUnusedDisableDirectives: 'error' }
					}
				],
				invalid: []
			})
		).not.toThrow();
	});

	describe('refuses a cursor on an encrypted store, whose update() writes without put or add', () => {
		it.each([
			['openCursor in a chain', "tx.objectStore('profile').openCursor();"],
			['openKeyCursor in a chain', "tx.objectStore('profile').openKeyCursor();"],
			['a variable holding the store', "const s = tx.objectStore('byok'); s.openCursor();"],
			[
				'openKeyCursor on a variable holding the store',
				"const s = tx.objectStore('timeline-state'); s.openKeyCursor();"
			],
			['a computed method name', "tx.objectStore('calendar-sync')['openCursor']();"],
			['a computed method in a template literal', "tx.objectStore('byok')[`openCursor`]();"],
			['a const-named store', "const S = 'profile'; tx.objectStore(S).openCursor();"],
			['an optional call', "tx.objectStore('profile')?.openCursor();"]
		])('%s', (_label, code) => {
			expect(() =>
				ruleTester.run('encrypted-store-registry', rule, {
					valid: [],
					invalid: [{ code, errors: [{ messageId: 'cursorOnEncryptedStore' }] }]
				})
			).not.toThrow();
		});

		it('allows a cursor on a store that is not encrypted', () => {
			expect(() =>
				ruleTester.run('encrypted-store-registry', rule, {
					valid: [
						{ code: "tx.objectStore('keystore').openCursor();" },
						{ code: "const s = tx.objectStore('profile-hwm'); s.openKeyCursor();" },
						{ code: 'tx.objectStore(name).openCursor();' }
					],
					invalid: []
				})
			).not.toThrow();
		});
	});

	describe('catches the same write in another shape', () => {
		it.each([
			['a variable holding the store', "const s = tx.objectStore('profile'); s.put(x);"],
			['a variable holding the store, add', "const s = tx.objectStore('profile'); s.add(x);"],
			[
				'a variable used in a closure',
				"function f(tx) { const s = tx.objectStore('profile'); return () => s.put(x); }"
			],
			['a computed put', "tx.objectStore('byok')['put'](x);"],
			['a computed add in a template literal', "tx.objectStore('byok')[`add`](x);"],
			['a computed objectStore', "tx['objectStore']('profile').put(x);"],
			['an optional put', "tx.objectStore('profile')?.put(x);"],
			[
				'a store passed through a second variable',
				"const t = tx.objectStore('profile'); const s = t; s.put(x);"
			],
			['a const-named store', "const S = 'profile'; tx.objectStore(S).put(x);"],
			['a template-literal store name', 'tx.objectStore(`calendar-sync`).put(x);'],
			[
				'a const-named store in a variable with a computed put',
				"const S = 'timeline-state'; const s = tx.objectStore(S); s['put'](x);"
			]
		])('%s', (_label, code) => {
			expectReported(code);
		});

		it.each([
			[
				'a typed variable holding the store',
				"const s = tx.objectStore('profile') as IDBObjectStore; (s as IDBObjectStore).put(x);"
			],
			['a non-null store', "(tx.objectStore('profile')!).put(x);"]
		])('%s', (_label, code) => {
			expectReported(code, { parser: ts.parser });
		});
	});
});
