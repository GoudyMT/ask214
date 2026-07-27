import { describe, it, expect } from 'vitest';
import { buildRetrieveBody, assertOnlyKeys } from './payload';

describe('online request payload allowlist', () => {
	it('builds a retrieve body with exactly {query}', () => {
		expect(buildRetrieveBody('  hello  ')).toEqual({ query: 'hello' });
	});
	it('accepts a body whose keys are all allowed', () => {
		expect(() => assertOnlyKeys({ query: 'x' }, ['query'])).not.toThrow();
	});
	it('rejects a body carrying any extra key (a PII-leak guard)', () => {
		expect(() => assertOnlyKeys({ query: 'x', rate: 'E5' }, ['query'])).toThrow();
	});
});
