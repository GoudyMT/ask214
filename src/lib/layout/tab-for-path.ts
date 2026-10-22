export type Tab = 'home' | 'timeline' | 'skillbridge' | 'more';

// Settings, Resources, Documents, Feedback and About sit behind the More tab, so it stays marked while one is open.
const MORE_PAGES = ['more', 'settings', 'resources', 'documents', 'feedback', 'about'];

/** The bottom-bar tab that holds the page at this path, or null for a page no tab owns (the first-run wizard). */
export function tabForPath(pathname: string): Tab | null {
	const first = pathname.split('/')[1] ?? '';
	if (first === '') return 'home';
	if (first === 'timeline' || first === 'skillbridge') return first;
	return MORE_PAGES.includes(first) ? 'more' : null;
}
