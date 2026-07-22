import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';

// The Ask moved to the home page (the front door - ADR-022/024). Keep /ask as a permanent redirect so
// existing links and bookmarks still reach it. Runs on server + client (no ssr=false: the redirect
// should fire server-side too), so it stays a plain load, not a rendered page.
export const prerender = false;

export function load() {
	redirect(308, resolve('/'));
}
