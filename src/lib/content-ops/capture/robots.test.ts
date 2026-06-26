import { describe, test, expect } from 'vitest';
import { isPathAllowed } from './robots';

const UA = 'MilTransitionCompanion';

describe('isPathAllowed', () => {
	test('empty / missing robots.txt allows everything', () => {
		expect(isPathAllowed('', UA, '/disability/')).toBe(true);
	});

	test('a Disallow under the * group blocks a matching path', () => {
		const txt = 'User-agent: *\nDisallow: /private/';
		expect(isPathAllowed(txt, UA, '/private/x')).toBe(false);
		expect(isPathAllowed(txt, UA, '/disability/')).toBe(true);
	});

	test('a more specific Allow overrides a broader Disallow', () => {
		const txt = 'User-agent: *\nDisallow: /a/\nAllow: /a/ok/';
		expect(isPathAllowed(txt, UA, '/a/ok/x')).toBe(true);
		expect(isPathAllowed(txt, UA, '/a/no')).toBe(false);
	});

	test('a group naming our UA takes precedence over *', () => {
		const txt = `User-agent: *\nDisallow: /\nUser-agent: ${UA}\nDisallow:`;
		expect(isPathAllowed(txt, UA, '/anything')).toBe(true);
	});

	test('a spurious substring group (matching only the UA comment) does not hijack our UA', () => {
		// the full UA carries a "(+contact: ...)" comment; a robots group naming "contact" must NOT capture
		// us - matching is on the product token (before "/"), so this falls through to the * group (allow).
		const fullUA = 'MilTransitionCompanion/1.0 (+contact: pending domain)';
		const txt = 'User-agent: contact\nDisallow: /\nUser-agent: *\nDisallow:';
		expect(isPathAllowed(txt, fullUA, '/anything')).toBe(true);
	});
});
