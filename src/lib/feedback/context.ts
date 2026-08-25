// Stores ONLY a sanitized app-route path (e.g. '/timeline') - a non-personal value that is
// identical for every user. Never the message, the reply email, or any profile data (those go
// straight from component state to the POST and are never persisted client-side).
import { sanitizeRoute, type KnownRoute } from './types';

const STASH_KEY = 'mtc:feedback:route';

/** Remember the route the user came from (best-effort; sessionStorage). */
export function stashRoute(path: string): void {
	const route = sanitizeRoute(path);
	try {
		if (route) sessionStorage.setItem(STASH_KEY, route);
		else sessionStorage.removeItem(STASH_KEY);
	} catch {
		/* sessionStorage unavailable - context is simply absent */
	}
}

/** Read + clear the stashed route (null if none / unavailable). */
export function readStashedRoute(): KnownRoute | null {
	try {
		const v = sessionStorage.getItem(STASH_KEY);
		sessionStorage.removeItem(STASH_KEY);
		return sanitizeRoute(v);
	} catch {
		return null;
	}
}
