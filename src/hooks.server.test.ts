import type { Handle } from '@sveltejs/kit/hooks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { handle } from './hooks.server';
import { parseHeadersFile } from '#lib/ci/headers-policy.js';

// Cloudflare applies `_headers` to the static files only: a page the Worker renders goes out with SvelteKit's
// headers alone, so the live pages had no HSTS, nosniff or Referrer-Policy. The hook gives them the same file's
// headers, and these tests run it the way SvelteKit does, on the response a page render returns.
const GLOBAL = parseHeadersFile(readFileSync(join(process.cwd(), '_headers'), 'utf8')).get('/*');
const PAGE_CSP = "default-src 'self'";

async function render(pathname: string, init?: ResponseInit): Promise<Headers> {
	const event = { url: new URL(`https://ask214.com${pathname}`) } as Parameters<Handle>[0]['event'];
	const response = await handle({
		event,
		resolve: async () =>
			new Response('<!doctype html>', {
				...init,
				headers: { 'content-security-policy': PAGE_CSP, ...init?.headers }
			})
	});
	return response.headers;
}

describe('handle', () => {
	it('sends every global header from _headers on a rendered page', async () => {
		const headers = await render('/ask');
		expect(Object.keys(GLOBAL ?? {})).toContain('Strict-Transport-Security');
		for (const [name, value] of Object.entries(GLOBAL ?? {})) {
			expect(headers.get(name), name).toBe(value);
		}
		expect(headers.get('cache-control')).toBeNull();
	});

	it('marks the pages that hold profile data no-store, and the settings pages under them', async () => {
		for (const path of ['/', '/wizard', '/settings', '/settings/backup', '/timeline']) {
			expect((await render(path)).get('cache-control'), path).toBe('no-store');
		}
	});

	// A redirect or a passed-through fetch comes with headers that cannot be changed; setting one would throw.
	it('adds the headers to a response whose own headers are locked', async () => {
		const event = { url: new URL('https://ask214.com/ask') } as Parameters<Handle>[0]['event'];
		const response = await handle({
			event,
			resolve: async () => Response.redirect('https://ask214.com/', 302)
		});
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://ask214.com/');
		expect(response.headers.get('strict-transport-security')).toBe(
			GLOBAL?.['Strict-Transport-Security']
		);
	});

	// The page's own policy carries the hashes of its inline scripts; a header from the file must never replace it. A
	// folder URL under /pdf-worker/ is no file, so the Worker draws the missing-page page there, and the file gives that
	// folder a policy of its own.
	it("keeps the page's own content security policy", async () => {
		expect((await render('/pdf-worker/6.3.289/')).get('content-security-policy')).toBe(PAGE_CSP);
	});
});
