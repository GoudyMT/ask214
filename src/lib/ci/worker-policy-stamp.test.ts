import { describe, expect, it } from 'vitest';
import { policyStamp } from './worker-policy-stamp';

const WORKERS = (policy: string) =>
	`/*\n  X-Content-Type-Options: nosniff\n\n/_app/immutable/workers/*\n  Content-Security-Policy: ${policy}\n`;

// The browser keeps a worker script for a year under its hashed name, headers included, so a policy added or
// changed for the workers folder reaches a returning device only when the script's name changes too. The stamp
// written into each worker script carries the policy into the bytes the name is hashed from.
describe('policyStamp', () => {
	it('is a short comment naming the policy, the same for the same policy', () => {
		const stamp = policyStamp(WORKERS("default-src 'self'"));
		expect(stamp).toMatch(/^\/\*p:[0-9a-f]{8}\*\/$/);
		expect(policyStamp(WORKERS("default-src 'self'"))).toBe(stamp);
	});

	it('changes when the workers policy changes', () => {
		expect(policyStamp(WORKERS("default-src 'self'"))).not.toBe(
			policyStamp(WORKERS("default-src 'none'"))
		);
	});

	it('refuses a headers file with no policy for the workers folder', () => {
		expect(() => policyStamp('/*\n  X-Content-Type-Options: nosniff\n')).toThrow(
			'E_WORKER_POLICY_MISSING'
		);
	});
});
