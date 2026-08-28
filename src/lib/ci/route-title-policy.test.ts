import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// WCAG 2.4.2 Page Titled (Level A): every page route must set a document <title>. SSR is off on the
// PII routes, so a title-less route leaves document.title as whatever the previous page set (or empty
// on a cold load) - a screen-reader / history / bookmark orientation failure. Gate the whole class so
// no new route can ship without one.
const ROUTES_DIR = fileURLToPath(new URL('../../routes', import.meta.url));

function pageRoutes(): string[] {
	return readdirSync(ROUTES_DIR, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name === '+page.svelte')
		.map((entry) => join(entry.parentPath, entry.name));
}

describe('every page route sets a non-empty document title (WCAG 2.4.2)', () => {
	for (const file of pageRoutes()) {
		const rel = file.slice(ROUTES_DIR.length + 1).replace(/\\/g, '/');
		it(`${rel} sets a non-empty <title>`, () => {
			// SvelteKit only hoists a <title> inside <svelte:head> to document.title. Strip HTML comments
			// so a commented-out title does not count, then require non-whitespace title text.
			const head = (
				readFileSync(file, 'utf8').match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? ''
			).replace(/<!--[\s\S]*?-->/g, '');
			const title = head.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() ?? '';
			expect(title.length, `${rel} must set a non-empty <svelte:head><title>`).toBeGreaterThan(0);
		});
	}
});
