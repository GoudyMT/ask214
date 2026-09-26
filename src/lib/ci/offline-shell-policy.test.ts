import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page the service worker falls back to offline (APP_SHELL in src/lib/ask/asset-cache.ts) loads its code by
// relative paths (`./_app/...`), which resolve correctly only from a top-level address. A nested page route would
// open offline as a blank page, so adding one must change the fallback first.
const ROUTES_DIR = fileURLToPath(new URL('../../routes', import.meta.url));

const pages = readdirSync(ROUTES_DIR, { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name === '+page.svelte')
	.map((entry) => relative(ROUTES_DIR, entry.parentPath).split(sep).filter(Boolean));

describe('every page route is top-level, so the offline fallback page can draw it', () => {
	it('finds the page routes', () => {
		expect(pages.length).toBeGreaterThanOrEqual(8);
	});
	for (const segments of pages) {
		it(`/${segments.join('/')} is at most one level deep`, () => {
			expect(segments.length).toBeLessThanOrEqual(1);
		});
	}
});
