import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHeadersFile } from './headers-policy';

describe('parseHeadersFile', () => {
	it('splits path blocks and their indented headers', () => {
		const parsed = parseHeadersFile(
			'/*\n  Referrer-Policy: no-referrer\n\n/wizard\n  Cache-Control: no-store\n'
		);
		expect(parsed.get('/*')).toEqual({ 'Referrer-Policy': 'no-referrer' });
		expect(parsed.get('/wizard')).toEqual({ 'Cache-Control': 'no-store' });
	});
});

describe('_headers policy (P1b)', () => {
	const headers = parseHeadersFile(readFileSync(join(process.cwd(), '_headers'), 'utf8'));

	it('global Referrer-Policy is tightened to no-referrer', () => {
		// no-referrer: never leak a referrer, even same-origin. Privacy-first default; OAuth
		// (v1.1) uses state/redirect_uri not Referer, and we run no referral analytics.
		expect(headers.get('/*')?.['Referrer-Policy']).toBe('no-referrer');
	});

	it('profile-touching routes set Cache-Control: no-store (BFCache opt-out)', () => {
		// PII routes must not be cached / BFCache-restored with decrypted state in memory
		// (memory hygiene). /settings/security is NOT included - it does not exist in
		// v1.0 (passphrase route deferred to v1.1).
		for (const path of ['/wizard', '/settings', '/settings/*']) {
			expect(headers.get(path)?.['Cache-Control'], `${path} must set no-store`).toBe('no-store');
		}
	});
});
