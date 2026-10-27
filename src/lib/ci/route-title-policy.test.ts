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

// SvelteKit only hoists a <title> inside <svelte:head> to document.title. Strip HTML comments so a
// commented-out title does not count.
function titleOf(file: string): string {
	const head = (
		readFileSync(file, 'utf8').match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1] ?? ''
	).replace(/<!--[\s\S]*?-->/g, '');
	return head.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() ?? '';
}

const APP_NAME = 'Ask 214';

describe('every page route sets a non-empty document title (WCAG 2.4.2)', () => {
	for (const file of pageRoutes()) {
		const rel = file.slice(ROUTES_DIR.length + 1).replace(/\\/g, '/');
		it(`${rel} sets a non-empty <title>`, () => {
			expect(
				titleOf(file).length,
				`${rel} must set a non-empty <svelte:head><title>`
			).toBeGreaterThan(0);
		});
	}
});

// A tab, a bookmark or the phone's list of open apps shows only the title: every page names the app after
// its own name, so a person with several tabs open can tell this app's pages apart. Home is the app itself.
describe('every page title ends with the app name', () => {
	for (const file of pageRoutes()) {
		const rel = file.slice(ROUTES_DIR.length + 1).replace(/\\/g, '/');
		it(`${rel} names the app in its <title>`, () => {
			const title = titleOf(file);
			expect(
				title === APP_NAME || title.endsWith(` - ${APP_NAME}`),
				`${rel}'s title "${title}" must be "${APP_NAME}" or end with " - ${APP_NAME}"`
			).toBe(true);
		});
	}
});
