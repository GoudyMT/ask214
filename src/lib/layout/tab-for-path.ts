export type Tab = 'home' | 'timeline' | 'skillbridge' | 'more';

// Settings, Resources, Documents, Feedback and About sit behind the More tab, so it stays marked while one is open.
const MORE_PAGES = ['more', 'settings', 'resources', 'documents', 'feedback', 'about'];

/** The bottom-bar tab that holds the page at this path, or null for a page no tab owns (the hidden finder, a missing page). */
export function tabForPath(pathname: string): Tab | null {
	// Every page is top level, so the whole path is the page; a trailing slash still names it.
	const first = pathname.replace(/\/+$/, '').slice(1);
	// The setup page is where Home sends a first-time visitor, so Home stays the tab marked while it is open.
	if (first === '' || first === 'wizard') return 'home';
	if (first === 'timeline' || first === 'skillbridge') return first;
	return MORE_PAGES.includes(first) ? 'more' : null;
}
