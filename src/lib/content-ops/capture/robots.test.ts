import { describe, test, expect } from 'vitest';
import { isPathAllowed } from './robots';

const UA = 'Ask214';

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
		// the full UA carries a "(+https://...)" comment; a robots group naming "about" must NOT capture
		// us - matching is on the product token (before "/"), so this falls through to the * group (allow).
		const fullUA = 'Ask214/1.0 (+https://ask214.com/about)';
		const txt = 'User-agent: about\nDisallow: /\nUser-agent: *\nDisallow:';
		expect(isPathAllowed(txt, fullUA, '/anything')).toBe(true);
	});
});
