import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import MorePage from './+page.svelte';

// The profile app the page reads and the page the person came from, both set per test.
const ctx = vi.hoisted(() => ({
	app: { status: 'ready' },
	cameFrom: null as string | null
}));

vi.mock('$lib/profile/context', () => ({ getProfileApp: () => ctx.app, setProfileApp: () => {} }));
// SvelteKit reports the previous page to afterNavigate; here the test says what it was.
vi.mock('$app/navigation', () => ({
	afterNavigate: (callback: (navigation: { from: { url: URL } | null }) => void) =>
		callback({
			from: ctx.cameFrom === null ? null : { url: new URL(ctx.cameFrom, window.location.origin) }
		})
}));

const STASH_KEY = 'mtc:feedback:route';

// Each group as the person sees it: a box of rows, every row one link with a title and a description.
const groups = () =>
	Array.from(document.querySelectorAll('ul')).map((list) =>
		Array.from(list.querySelectorAll('a')).map((link) => ({
			href: link.getAttribute('href'),
			rel: link.getAttribute('rel'),
			title: link.children[0]?.textContent,
			text: link.children[1]?.textContent
		}))
	);

const SETTINGS = {
	href: '/settings',
	rel: null,
	title: 'Settings',
	text: 'Your dates, backup, theme, online answers'
};
const LISTED = [
	[
		{
			href: '/resources',
			rel: null,
			title: 'Resources',
			text: 'Official links for benefits, jobs and school'
		},
		{ href: '/documents', rel: null, title: 'Documents', text: 'Guides saved for offline' }
	],
	[
		{ href: '/feedback', rel: null, title: 'Feedback', text: 'Tell us what to fix or add' },
		{
			href: '/about',
			rel: null,
			title: 'About',
			text: 'Sources, privacy, how Ask 214 works'
		},
		{
			href: 'https://github.com/GoudyMT/ask214',
			rel: 'external',
			title: 'Source code',
			text: 'On GitHub'
		}
	]
];

// Stops the browser leaving the test page when a row is clicked; the row's own handler still runs, because
// preventDefault does not stop other listeners.
const keepPageStill = (event: Event) => event.preventDefault();

beforeEach(() => {
	ctx.app.status = 'ready';
	ctx.cameFrom = null;
	sessionStorage.removeItem(STASH_KEY);
	document.addEventListener('click', keepPageStill, true);
});

afterEach(() => {
	document.removeEventListener('click', keepPageStill, true);
	sessionStorage.removeItem(STASH_KEY);
});

describe('the More page', () => {
	// A phone user opens More to reach what the bottom bar does not hold.
	it('lists the pages in their groups, each row one link with its title and description', async () => {
		await render(MorePage);

		await expect.element(page.getByRole('heading', { level: 1, name: 'More' })).toBeVisible();
		expect(document.title).toBe('More - Ask 214');
		expect(groups()).toEqual([[SETTINGS], ...LISTED]);
		await expect
			.element(
				page.getByText(
					'New tools land here first. A tool moves to the bottom bar only once people use it a lot.'
				)
			)
			.toBeVisible();
	});

	// The header offers Settings only when the app is ready or damaged; before that there is nothing to set.
	it.each(['ready', 'damaged'])('offers Settings when the app is %s', async (status) => {
		ctx.app.status = status;
		await render(MorePage);

		expect(groups()[0]).toEqual([SETTINGS]);
	});

	it.each(['loading', 'unsupported', 'stale', 'error'])(
		'leaves the whole Settings group out when the app is %s',
		async (status) => {
			ctx.app.status = status;
			await render(MorePage);

			expect(groups()).toEqual(LISTED);
		}
	);

	// Feedback is reported with the page it came from; reaching it through More must not lose that.
	it('keeps the page the person came from when they open Feedback', async () => {
		ctx.cameFrom = '/timeline';
		await render(MorePage);

		await page.getByRole('link', { name: 'Feedback' }).click();

		expect(sessionStorage.getItem(STASH_KEY)).toBe('/timeline');
	});

	// More opened directly has no earlier page; a stale page name from before must not ride along.
	it('clears an old page name when More was opened directly', async () => {
		sessionStorage.setItem(STASH_KEY, '/resources');
		await render(MorePage);

		await page.getByRole('link', { name: 'Feedback' }).click();

		expect(sessionStorage.getItem(STASH_KEY)).toBeNull();
	});
});
