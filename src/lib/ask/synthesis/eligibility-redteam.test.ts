// Red-team validation of the 38-CFR eligibility gate against a realistic first-person query distribution,
// not the four illustrative cases in eligibility-gate.test.ts. Every Group-A query pairs personal framing
// with an entitlement ask and MUST short-circuit; every Group-B query is impersonal / general-info and MUST
// NOT. A miss here is a real gap in the detector -- fix the pattern, never this fixture (fail-closed).
import { describe, it, expect } from 'vitest';
import { detectEligibilityIntent } from './eligibility-gate';
import cases from './eligibility-redteam.json';

describe('eligibility-gate red-team set', () => {
	for (const c of cases) {
		it(`${c.shortCircuit ? 'short-circuits' : 'allows'}: ${c.query}`, () => {
			expect(detectEligibilityIntent(c.query).shortCircuit).toBe(c.shortCircuit);
		});
	}
});
