import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pull the Cloudflare account-id rule's regex out of the committed `.gitleaks.toml` and compile it
 * for behavioural assertions.
 *
 * gitleaks runs Go/RE2; JS RegExp rejects the inline `(?i)` flag, so it is translated to the JS `i`
 * flag. For this pattern (no lookaround or backreferences) the two engines agree, so the JS match
 * is a faithful stand-in for what gitleaks does in CI.
 */
function accountIdRegex(): RegExp {
	const toml = readFileSync(join(process.cwd(), '.gitleaks.toml'), 'utf8');
	const block = toml.split('[[rules]]').find((b) => b.includes('cloudflare-account-id-in-config'));
	if (block === undefined) throw new Error('account-id rule not found in .gitleaks.toml');
	const match = block.match(/regex\s*=\s*'''([\s\S]*?)'''/);
	const raw = match?.[1];
	if (raw === undefined) throw new Error('account-id rule has no regex');
	if (raw.startsWith('(?i)')) return new RegExp(raw.slice(4), 'i');
	return new RegExp(raw);
}

describe('gitleaks account-id rule catches every committed form', () => {
	const rule = accountIdRegex();
	const HEX = '0123456789abcdef0123456789abcdef';

	it('matches the JSONC deploy form (the wrangler.jsonc shape)', () => {
		expect(rule.test(`"account_id": "${HEX}"`)).toBe(true);
	});

	it('matches the camelCase form', () => {
		expect(rule.test(`"accountId": "${HEX}"`)).toBe(true);
	});

	it('matches the TOML/env form', () => {
		expect(rule.test(`account_id = "${HEX}"`)).toBe(true);
	});

	it('does not match a benign non-account 32-hex value', () => {
		expect(rule.test(`"contentHash": "${HEX}"`)).toBe(false);
	});
});
