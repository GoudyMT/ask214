import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disablesSsr } from './ssr-policy';

describe('disablesSsr', () => {
	it('detects export const ssr = false', () => {
		expect(disablesSsr('export const ssr = false;\nexport const prerender = false;')).toBe(true);
	});

	it('is false when ssr is not set at all', () => {
		expect(disablesSsr('export const prerender = false;')).toBe(false);
	});

	it('is false when ssr is explicitly true', () => {
		expect(disablesSsr('export const ssr = true;')).toBe(false);
	});

	it('is false when the ssr = false declaration is commented out', () => {
		expect(disablesSsr('// export const ssr = false')).toBe(false);
		expect(disablesSsr('/* export const ssr = false */')).toBe(false);
	});
});

// ADR-004: PII renders client-side only. Each profile-touching route must disable SSR so its HTML
// shell (which the service worker caches network-first for offline) is empty -- never server-rendered
// personal data. This is the load-bearing control; the SW-cache bypass is optional defense-in-depth.
const PII_ROUTES = ['wizard', 'settings', 'timeline'];

describe('every PII route disables SSR (ADR-004)', () => {
	for (const route of PII_ROUTES) {
		it(`/${route} sets ssr = false`, () => {
			const source = readFileSync(join(process.cwd(), 'src', 'routes', route, '+page.ts'), 'utf8');
			expect(disablesSsr(source)).toBe(true);
		});
	}
});
