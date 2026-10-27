import { describe, it, expect } from 'vitest';
import { tabForPath, type Tab } from './tab-for-path';

// tabForPath names the bottom-bar tab that holds the page being read, so the bar can mark it current. The pages
// Settings, Resources, Documents, Feedback and About all sit behind the More tab, and the setup page is Home's first-run
// path; a page no tab owns marks none.
describe('tabForPath', () => {
	it.each<[string, Tab | null]>([
		['/', 'home'],
		['/timeline', 'timeline'],
		['/skillbridge', 'skillbridge'],
		['/more', 'more'],
		['/settings', 'more'],
		['/resources', 'more'],
		['/documents', 'more'],
		['/feedback', 'more'],
		['/about', 'more'],
		['/more/', 'more'],
		['/wizard', 'home'],
		// Every page is top level: a missing page under a tab's address belongs to no tab.
		['/more/zzz', null],
		['/documents/zzz', null],
		['/skillbridge/x', null]
	])('maps %s to %s', (pathname, tab) => {
		expect(tabForPath(pathname)).toBe(tab);
	});
});
