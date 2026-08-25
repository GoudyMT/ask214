export const MAX_MESSAGE_LEN = 4000;
export const MAX_EMAIL_LEN = 254; // RFC 5321 practical max

export const KNOWN_ROUTES = [
	'/',
	'/timeline',
	'/ask',
	'/resources',
	'/settings',
	'/about',
	'/feedback'
] as const;
export type KnownRoute = (typeof KNOWN_ROUTES)[number];

export interface FeedbackInput {
	message: string;
	route?: string | null;
	replyEmail?: string | null;
	honeypot?: string;
}

export interface CleanFeedback {
	message: string;
	route: KnownRoute | null;
	replyEmail: string | null;
}

export type FeedbackReason = 'empty' | 'too_long' | 'bad_email' | 'spam';
export type FeedbackValidation =
	{ ok: true; value: CleanFeedback } | { ok: false; reason: FeedbackReason };

/** Reduce a path to a known app route, or null. Strips query/hash; allowlist only. */
export function sanitizeRoute(path: string | null | undefined): KnownRoute | null {
	if (!path) return null;
	const clean = path.split('?')[0]?.split('#')[0] ?? '';
	return (KNOWN_ROUTES as readonly string[]).includes(clean) ? (clean as KnownRoute) : null;
}

const ROUTE_LABELS: Record<KnownRoute, string> = {
	'/': 'Home',
	'/timeline': 'Timeline',
	'/ask': 'Ask',
	'/resources': 'Resources',
	'/settings': 'Settings',
	'/about': 'About',
	'/feedback': 'Feedback'
};

/** Friendly page name for display + the email (e.g. '/' -> 'Home'); null -> null. */
export function routeLabel(route: KnownRoute | null): string | null {
	return route ? ROUTE_LABELS[route] : null;
}
