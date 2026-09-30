import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page the service worker falls back to offline (APP_SHELL in src/lib/ask/asset-cache.ts) loads its code by
// relative paths (`./_app/...`), which resolve correctly only from a top-level address. A nested page route would
// open offline as a blank page, so adding one must change the fallback first.
const ROUTES_DIR = fileURLToPath(new URL('../../routes', import.meta.url));

// A page route is any folder with a page file - a component, or only a load (a redirect) - since the shell draws it,
// including a page that resets its layout (`+page@.svelte`). A route group's folder (`(name)`) is not part of the
// address, and a rest parameter (`[...name]`) answers addresses of any depth, so it counts as nested.
const pages = [
	...new Set(
		readdirSync(ROUTES_DIR, { recursive: true, withFileTypes: true })
			.filter(
				(entry) => entry.isFile() && /^\+page(@[^.]*)?(\.server)?\.(svelte|ts|js)$/.test(entry.name)
			)
			.map((entry) => relative(ROUTES_DIR, entry.parentPath))
	)
].map((folder) =>
	folder.split(sep).filter((segment) => segment !== '' && !/^\(.+\)$/.test(segment))
);

describe('every page route is top-level, so the offline fallback page can draw it', () => {
	it('finds the page routes', () => {
		expect(pages.length).toBeGreaterThanOrEqual(8);
	});
	for (const segments of pages) {
		it(`/${segments.join('/')} is at most one level deep`, () => {
			const depth =
				segments.length + (segments.some((segment) => segment.startsWith('[...')) ? 1 : 0);
			expect(depth).toBeLessThanOrEqual(1);
		});
	}
});

// The precache budget counts the pages kept at install from INSTALL_PAGES (content-ops/check-chunk-budget.mjs), so
// the worker must install exactly that list beside the build files - a page added to install alone would go
// uncounted.
describe('the worker installs the pages the budget counts', () => {
	it('installs INSTALL_PAGES with the precache, and nothing else', () => {
		const worker = readFileSync(join(process.cwd(), 'src/service-worker.ts'), 'utf8');
		expect(worker).toMatch(/cache\.addAll\(\[\.\.\.PRECACHE, \.\.\.INSTALL_PAGES\]\)/);
		// The one precache call at install (the library restore and the worker script store with put): no second
		// add, even a commented-out one, beside it.
		expect(worker.match(/\.add(All)?\(/g)).toHaveLength(1);
	});
});
