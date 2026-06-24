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
});
