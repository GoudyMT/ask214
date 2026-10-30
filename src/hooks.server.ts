import type { Handle } from '@sveltejs/kit/hooks';
import { headersFor, parseHeadersFile } from '#lib/ci/headers-policy.js';
import headersFile from '../_headers?raw';

// Cloudflare applies `_headers` to the static files it serves, never to a response the Worker writes, so a rendered
// page would go out without HSTS, nosniff or its no-store. Reading the same file keeps one list for both. A header the
// response already has stays: the page's own policy carries the hashes of its inline scripts.
const RULES = parseHeadersFile(headersFile);

export const handle: Handle = async ({ event, resolve }) => {
	// A copy, because a redirect or a passed-through fetch has headers that cannot be changed.
	const resolved = await resolve(event);
	const response = new Response(resolved.body, resolved);
	for (const [name, value] of Object.entries(headersFor(RULES, event.url.pathname))) {
		if (!response.headers.has(name)) response.headers.set(name, value);
	}
	return response;
};
