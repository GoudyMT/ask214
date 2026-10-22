import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfileStore } from '$lib/profile/store.svelte';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { readStashedRoute, stashRoute } from '$lib/feedback/context';
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

// The layout reads the open page's path from the router; a test sets the path it wants before it renders.
const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return new URL(route.pathname, 'https://ask214.test');
		}
	}
}));

// A page tall enough to scroll, with one link at its top.
const children = createRawSnippet(() => ({
	render: () => '<div style="height: 2000px"><a href="#top-of-page">first</a></div>'
}));

let db: IDBDatabase | null = null;
let restoreSize = { width: 0, height: 0 };

beforeEach(async () => {
	route.pathname = '/';
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
	// What the footer link stashes must not reach the next test.
	sessionStorage.removeItem('mtc:feedback:route');
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

/** Presses the footer's Feedback link without leaving the test page. */
async function clickFooterFeedback(): Promise<void> {
	const stayHere = (event: Event) => event.preventDefault();
	document.addEventListener('click', stayHere, true);
	try {
		await page.getByRole('link', { name: 'Feedback' }).click();
	} finally {
		document.removeEventListener('click', stayHere, true);
	}
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

	// Below 600 px the bar is the only menu: a keyboard user (400% zoom) reaches it right after the brand, as the desktop
	// menu comes first in the header, instead of tabbing through the whole page.
	it('reaches the bar right after the brand link with the Tab key at 320 px', async () => {
		await openAt(320, 568);
		(document.querySelector('header a.brand') as HTMLElement).focus({ preventScroll: true });
		await userEvent.tab();
		expect(document.activeElement).toBe(document.querySelector('.bottom-bar a'));
		expect(document.activeElement?.textContent?.trim()).toBe('Home');
	});

	// WCAG 2.4.11: a scroll that brings an element into view with no focus (find in page, an anchor, a script) must stop
	// short of the fixed bar; the page's scroll padding is what says where the bar starts. The footer is the last thing
	// on every page.
	it('keeps the last footer link above the bar when it is scrolled into view at 320 px', async () => {
		await openAt(320, 568);
		const last = [...document.querySelectorAll<HTMLAnchorElement>('footer a')].at(
			-1
		) as HTMLAnchorElement;
		const bar = document.querySelector('.bottom-bar') as HTMLElement;
		last.scrollIntoView({ block: 'end' });
		await expect
			.poll(() => last.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top)
			.toBe(true);
	});

	// A phone on its side is 481 to 599 px wide: the narrow-phone footer rule does not apply there, so the room the
	// footer keeps for the bar has to come from the rule for every phone width.
	it('keeps the last footer link above the bar at the bottom of the page at 568x320', async () => {
		await openAt(568, 320);
		const last = [...document.querySelectorAll<HTMLAnchorElement>('footer a')].at(
			-1
		) as HTMLElement;
		const bar = document.querySelector('.bottom-bar') as HTMLElement;
		window.scrollTo(0, document.documentElement.scrollHeight);
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

	// A passage taller than the strip between header and bar (Ask's "More detail") is moved up only until its first line
	// is below the header: lining its bottom up with the bar would send its first lines off the top of the screen.
	it('never moves the first line of a tall focused control above the header at 320 px', async () => {
		await openAt(320, 568);
		const header = document.querySelector('header') as HTMLElement;
		const holder = document.createElement('div');
		holder.innerHTML =
			'<div style="height: 300px"></div><p tabindex="-1" style="height: 800px; margin: 0">passage</p>';
		(document.querySelector('main') as HTMLElement).prepend(holder);
		try {
			const tall = holder.querySelector('p') as HTMLElement;
			expect(tall.getBoundingClientRect().top).toBeLessThan(
				(document.querySelector('.bottom-bar') as HTMLElement).getBoundingClientRect().top
			);
			tall.focus({ preventScroll: true });
			await expect
				.poll(() => tall.getBoundingClientRect().top >= header.getBoundingClientRect().bottom)
				.toBe(true);
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			expect(tall.getBoundingClientRect().top).toBeGreaterThanOrEqual(
				header.getBoundingClientRect().bottom
			);
		} finally {
			holder.remove();
		}
	});

	// A control a little taller than the strip between header and bar: the move that brings it clear of the bar also hides
	// the header, so the header's room is not needed above it and the control must end fully above the bar.
	it('moves a control a little taller than the strip fully above the bar at 320x180', async () => {
		await openAt(320, 180);
		const header = document.querySelector('header') as HTMLElement;
		const bar = document.querySelector('.bottom-bar') as HTMLElement;
		const strip = bar.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
		const tall = document.createElement('p');
		tall.tabIndex = -1;
		tall.style.cssText = `height: ${strip + 34}px; margin: 0`;
		(document.querySelector('main') as HTMLElement).prepend(tall);
		try {
			tall.focus({ preventScroll: true });
			await expect
				.poll(() => tall.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top)
				.toBe(true);
		} finally {
			tall.remove();
		}
	});

	// Chromium sends focusin again to a control that kept focus when the window comes back, with no scroll asked for: a
	// control far below the window must not pull the page down to it.
	it('leaves the page at the top when a control far below the window takes focus at 320 px', async () => {
		await openAt(320, 568);
		const last = [...document.querySelectorAll<HTMLAnchorElement>('footer a')].at(
			-1
		) as HTMLElement;
		expect(last.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
		last.focus({ preventScroll: true });
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
		expect(window.scrollY).toBe(0);
	});

	// From 600 px the bar is gone (its box has no place on screen), so nothing is under it: focus must never move the page
	// for it. Only the phone-width gate on the listener keeps a desktop page still.
	it('leaves the page where it is when a control in view takes focus at 1280 px', async () => {
		await openAt(1280, 800);
		const holder = document.createElement('div');
		holder.innerHTML =
			'<div style="height: 600px"></div><p tabindex="-1" style="height: 40px; margin: 0">control</p>';
		(document.querySelector('main') as HTMLElement).prepend(holder);
		try {
			window.scrollTo(0, 300);
			await expect.poll(() => window.scrollY).toBe(300);
			const control = holder.querySelector('p') as HTMLElement;
			expect(control.getBoundingClientRect().top).toBeGreaterThan(0);
			expect(control.getBoundingClientRect().top).toBeLessThan(window.innerHeight);
			control.focus({ preventScroll: true });
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			expect(window.scrollY).toBe(300);
		} finally {
			holder.remove();
		}
	});

	// WebKit scrolls a control focused from script to the window's bottom edge after focusin, without the scroll padding,
	// so it lands partly under the bar. A scroll after the focus stands in for that engine here.
	it('clears a control of the bar after the browser scrolls it into the window late at 320 px', async () => {
		await openAt(320, 568);
		const last = [...document.querySelectorAll<HTMLAnchorElement>('footer a')].at(
			-1
		) as HTMLElement;
		const bar = document.querySelector('.bottom-bar') as HTMLElement;
		expect(last.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
		last.focus({ preventScroll: true });
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
		window.scrollBy(0, last.getBoundingClientRect().top - (bar.getBoundingClientRect().top - 11));
		expect(last.getBoundingClientRect().bottom).toBeGreaterThan(bar.getBoundingClientRect().top);
		await expect
			.poll(() => last.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top)
			.toBe(true);
	});

	// At a large text size the labels wrap and the bar is taller than its first-paint 57 px: the room the page keeps for it
	// must follow, or the footer's last line ends under the bar at the end of every page.
	it('keeps the last footer link above a taller bar at the bottom of the page at 320x640', async () => {
		const root = document.documentElement;
		root.style.setProperty('--font-size-s', '28px');
		try {
			await openAt(320, 640);
			const last = [...document.querySelectorAll<HTMLAnchorElement>('footer a')].at(
				-1
			) as HTMLElement;
			const bar = document.querySelector('.bottom-bar') as HTMLElement;
			expect(bar.offsetHeight).toBeGreaterThan(57);
			window.scrollTo(0, document.documentElement.scrollHeight);
			await expect
				.poll(() => last.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top)
				.toBe(true);
		} finally {
			root.style.removeProperty('--font-size-s');
		}
	});

	// From 600 px the header carries the menu: at 200 % text the brand and the four links no longer fit one line, so the
	// row must wrap instead of pushing the page sideways.
	it('does not scroll sideways at 600 px with text at 200 %', async () => {
		const root = document.documentElement;
		root.style.setProperty('--font-size-base', '32px');
		try {
			await openAt(600, 600);
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
		} finally {
			root.style.removeProperty('--font-size-base');
		}
	});

	// Wrapping is only for when the line is full: at normal text the header is one line, 57 px tall, as before.
	it.each([600, 1280])(
		'keeps the header one line, 57 px tall at %i px and normal text',
		async (width) => {
			await openAt(width, 800);
			expect((document.querySelector('header') as HTMLElement).getBoundingClientRect().height).toBe(
				57
			);
		}
	);

	// With the header slid away, Shift+Tab from the bar's first tab reaches the brand: the browser would scroll the page
	// up to an off-screen brand, so the header that holds focus must be in place before it looks, and the page stays.
	it('keeps the page still when Shift+Tab reaches the brand in the hidden header at 320x640', async () => {
		await openAt(320, 640);
		window.scrollTo(0, 600);
		const header = document.querySelector('header') as HTMLElement;
		await expect.poll(() => header.hasAttribute('data-hidden')).toBe(true);
		(document.querySelector('.bottom-bar a') as HTMLElement).focus({ preventScroll: true });
		await userEvent.tab({ shift: true });
		expect(document.activeElement).toBe(header.querySelector('a.brand'));
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
		expect(window.scrollY).toBe(600);
		expect(header.hasAttribute('data-hidden')).toBe(false);
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

	// More is not a page feedback can name, and More itself remembers the page the person came from: the footer's
	// Feedback link on More must not overwrite that with "More".
	it('keeps the remembered page when the footer Feedback link is used on More', async () => {
		route.pathname = '/more';
		stashRoute('/timeline');
		await openAt(320, 568);
		await clickFooterFeedback();
		expect(readStashedRoute()).toBe('/timeline');
	});

	// Anywhere else the page the link is used on is the page feedback names.
	it('names the open page when the footer Feedback link is used on an ordinary page', async () => {
		route.pathname = '/timeline';
		await openAt(320, 568);
		await clickFooterFeedback();
		expect(readStashedRoute()).toBe('/timeline');
	});

	// The source reader is a modal dialog above the bar and focuses its cited passage on open: the page behind the
	// backdrop must hold still, or it scrolls and the header hides under the reader.
	it('leaves the page where it is when focus moves inside an open dialog at 390 px', async () => {
		await openAt(390, 844);
		window.scrollTo(0, 300);
		await expect.poll(() => window.scrollY).toBe(300);
		const dialog = document.createElement('dialog');
		// The passage starts inside the window and runs under the bar, so only the dialog check keeps the page still.
		dialog.style.cssText =
			'position: fixed; inset: 0; margin: 0; padding: 0; border: 0; max-height: none; max-width: none';
		dialog.innerHTML =
			'<div style="height: 700px"></div><p tabindex="-1" style="height: 150px; margin: 0">cited</p>';
		document.body.appendChild(dialog);
		try {
			dialog.showModal();
			const cited = dialog.querySelector('p') as HTMLElement;
			const bar = document.querySelector('.bottom-bar') as HTMLElement;
			expect(cited.getBoundingClientRect().top).toBeLessThan(window.innerHeight);
			expect(cited.getBoundingClientRect().bottom).toBeGreaterThan(bar.getBoundingClientRect().top);
			cited.focus({ preventScroll: true });
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			expect(window.scrollY).toBe(300);
		} finally {
			dialog.close();
			dialog.remove();
		}
	});
});
