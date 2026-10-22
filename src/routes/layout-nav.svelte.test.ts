import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfileStore } from '$lib/profile/store.svelte';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import Layout from './+layout.svelte';

// The real layout starts up on a test database with a saved profile (status ready); only the database it opens is
// pointed at the test one.
const harness = vi.hoisted(() => ({ name: '' }));
vi.mock('$lib/db/schema', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/db/schema')>();
	return {
		...real,
		openMtcDb: (...args: Parameters<typeof real.openMtcDb>) =>
			real.openMtcDb(args[0] === undefined ? harness.name : args[0], args[1], args[2])
	};
});

// A page tall enough to scroll, with one link at its top.
const children = createRawSnippet(() => ({
	render: () => '<div style="height: 2000px"><a href="#top-of-page">first</a></div>'
}));

let db: IDBDatabase | null = null;
let restoreSize = { width: 0, height: 0 };

beforeEach(async () => {
	restoreSize = { width: window.innerWidth, height: window.innerHeight };
	db = await openTestDb();
	harness.name = db.name;
	await bootstrapLocalKeystore(db);
	await createProfileStore(db).save({
		eaos: new TextEncoder().encode('2027-04-15'),
		setupIntent: 'completed'
	});
	// The test page has no service worker file to register.
	vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue({} as ServiceWorkerRegistration);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await page.viewport(restoreSize.width, restoreSize.height);
	if (db) await deleteTestDb(db);
	db = null;
});

/** Renders the layout at a width and waits for the saved profile to be read, which is when Settings is offered. */
async function openAt(width: number, height: number): Promise<void> {
	await page.viewport(width, height);
	await render(Layout, { children });
	await expect
		.poll(() =>
			[...document.querySelectorAll('a')].some((a) => a.textContent?.trim() === 'Settings')
		)
		.toBe(true);
}

const primaryNavs = () =>
	[...document.querySelectorAll<HTMLElement>('nav[aria-label="Primary"]')].filter(
		(n) => getComputedStyle(n).display !== 'none'
	);
const linkTexts = (nav: Element) =>
	[...nav.querySelectorAll('a')].map((a) => a.textContent?.trim());

describe('the root layout navigation', () => {
	// A screen reader lists landmarks: two shown "Primary" menus would read as the same menu twice.
	it('shows the top menu and no bar at 1280 px, with SkillBridge among the links', async () => {
		await openAt(1280, 800);
		const [only, ...others] = primaryNavs();
		expect(others).toHaveLength(0);
		expect(only?.closest('header')).not.toBeNull();
		expect(linkTexts(only as Element)).toEqual([
			'Timeline',
			'SkillBridge',
			'Resources',
			'Settings'
		]);
		const brand = document.querySelector('header a.brand') as HTMLAnchorElement;
		expect(brand.textContent?.trim()).toBe('Ask 214');
		expect(brand.closest('nav')).toBeNull();
	});

	it('shows the bottom bar and no top menu at 320 px, the brand still in the header', async () => {
		await openAt(320, 568);
		const [only, ...others] = primaryNavs();
		expect(others).toHaveLength(0);
		expect(only?.closest('header')).toBeNull();
		expect(linkTexts(only as Element)).toEqual(['Home', 'Timeline', 'SkillBridge', 'More']);
		expect(getComputedStyle(document.querySelector('header a.brand') as Element).display).not.toBe(
			'none'
		);
	});

	// WCAG 2.4.11: a focused control must not sit under the fixed bar. The footer is the last thing on every page.
	it('keeps the last footer link above the bar when keyboard focus reaches it at 320 px', async () => {
		await openAt(320, 568);
		const footerLinks = [...document.querySelectorAll<HTMLAnchorElement>('footer a')];
		const last = footerLinks.at(-1) as HTMLAnchorElement;
		const before = footerLinks.at(-2) as HTMLAnchorElement;
		const bar = [...document.querySelectorAll('nav[aria-label="Primary"]')].find(
			(n) => !n.closest('header')
		) as HTMLElement;
		// The browser leaves a control that is already fully on screen where it is, so park the page with the link
		// in view but inside the strip the bar covers: only the scroll padding then tells it to move the page.
		window.scrollBy(0, last.getBoundingClientRect().bottom - (window.innerHeight - 8));
		expect(last.getBoundingClientRect().bottom).toBeGreaterThan(bar.getBoundingClientRect().top);
		before.focus({ preventScroll: true });
		await userEvent.tab();
		expect(document.activeElement).toBe(last);
		// The scroll that brings the link into view settles after the key press.
		await expect
			.poll(() => last.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top)
			.toBe(true);
	});

	// WebKit leaves a focused control that is already inside the window where it is, even with part of it under the
	// bar (the question field on a short screen). A focus that does not scroll stands in for that engine here.
	it('moves a focused control clear of the bar when the browser does not scroll to it at 320 px', async () => {
		await openAt(320, 568);
		const last = [...document.querySelectorAll<HTMLAnchorElement>('footer a')].at(
			-1
		) as HTMLElement;
		const bar = document.querySelector('.bottom-bar') as HTMLElement;
		window.scrollBy(0, last.getBoundingClientRect().bottom - (window.innerHeight - 8));
		expect(last.getBoundingClientRect().bottom).toBeGreaterThan(bar.getBoundingClientRect().top);
		last.focus({ preventScroll: true });
		await expect
			.poll(() => last.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top)
			.toBe(true);
	});

	// The bar's own links always sit "under the bar": focusing one must not push the page.
	it('leaves the page where it is when focus enters the bar itself at 320 px', async () => {
		await openAt(320, 568);
		window.scrollTo(0, 300);
		await expect.poll(() => window.scrollY).toBe(300);
		(document.querySelector('.bottom-bar a') as HTMLElement).focus({ preventScroll: true });
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
		expect(window.scrollY).toBe(300);
	});
});
