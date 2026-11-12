import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfileStore } from '#lib/profile/store.svelte.js';
import { bootstrapLocalKeystore } from '#lib/keystore/bootstrap.js';
import { deleteTestDb, openTestDb } from '#lib/db/_test-helpers.js';
import { readStashedRoute, stashRoute } from '#lib/feedback/context.js';
import Layout from './+layout.svelte';

// The real layout starts up on a test database with a saved profile (status ready); only the database it opens is
// pointed at the test one.
const harness = vi.hoisted(() => ({ name: '' }));
vi.mock('#lib/db/schema.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/db/schema.js')>();
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

/**
 * Focuses as the keyboard does: a key press first, so the browser treats the focus as keyboard focus (it matches
 * :focus-visible) whatever a test before it clicked. No scroll: each test moves the page itself.
 */
async function keyboardFocus(el: HTMLElement): Promise<void> {
	await userEvent.keyboard('{Shift}');
	el.focus({ preventScroll: true });
}

const primaryNavs = () =>
	[...document.querySelectorAll<HTMLElement>('nav[aria-label="Primary"]')].filter(
		(n) => getComputedStyle(n).display !== 'none'
	);
const linkTexts = (nav: Element) =>
	[...nav.querySelectorAll('a')].map((a) => a.textContent?.trim());

describe('the root layout navigation', () => {
	// A screen reader lists landmarks: two shown "Primary" menus would read as the same menu twice.
	it('shows the top menu and no bar at 1280 px', async () => {
		await openAt(1280, 800);
		const [only, ...others] = primaryNavs();
		expect(others).toHaveLength(0);
		expect(only?.closest('header')).not.toBeNull();
		expect(linkTexts(only as Element)).toEqual(['Timeline', 'Resources', 'Settings']);
		const brand = document.querySelector('header a.brand') as HTMLAnchorElement;
		expect(brand.textContent?.trim()).toBe('Ask 214');
		expect(brand.closest('nav')).toBeNull();
	});

	it('shows the bottom bar and no top menu at 320 px, the brand still in the header', async () => {
		await openAt(320, 568);
		const [only, ...others] = primaryNavs();
		expect(others).toHaveLength(0);
		expect(only?.closest('header')).toBeNull();
		expect(linkTexts(only as Element)).toEqual(['Home', 'Timeline', 'More']);
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

	// WCAG 2.4.11: Shift+Tab to a control above the window scrolls it to the window's top edge in both engines, where the
	// shown header covers it whole (a source title on About, the date field in setup). A focus that does not scroll, on
	// a control placed under the header, stands in for that scroll here.
	it.each([
		[1280, 800],
		[320, 640]
	])('moves a focused control out from under the shown header at %ix%i', async (width, height) => {
		await openAt(width, height);
		const header = document.querySelector('header') as HTMLElement;
		const holder = document.createElement('div');
		holder.innerHTML =
			'<div style="height: 600px"></div><p tabindex="-1" style="height: 24px; margin: 0">control</p>';
		(document.querySelector('main') as HTMLElement).prepend(holder);
		try {
			const control = holder.querySelector('p') as HTMLElement;
			window.scrollBy(0, control.getBoundingClientRect().top - 15);
			if (width < 600) await expect.poll(() => header.hasAttribute('data-hidden')).toBe(true);
			// A scroll up shows a slid-away phone header again, as a Shift+Tab scroll up does; wait until it is back in place.
			window.scrollBy(0, -5);
			await expect.poll(() => header.getBoundingClientRect().bottom).toBe(header.offsetHeight);
			expect(control.getBoundingClientRect().bottom).toBeLessThanOrEqual(
				header.getBoundingClientRect().bottom
			);
			await keyboardFocus(control);
			await expect
				.poll(() => control.getBoundingClientRect().top >= header.getBoundingClientRect().bottom)
				.toBe(true);
		} finally {
			holder.remove();
		}
	});

	// A slid-away header covers nothing: a control at the top of the window must not pull the page down for it.
	it('leaves the page where it is when a control sits under the hidden header at 320x640', async () => {
		await openAt(320, 640);
		const header = document.querySelector('header') as HTMLElement;
		const holder = document.createElement('div');
		holder.innerHTML =
			'<div style="height: 600px"></div><p tabindex="-1" style="height: 24px; margin: 0">control</p>';
		(document.querySelector('main') as HTMLElement).prepend(holder);
		try {
			const control = holder.querySelector('p') as HTMLElement;
			window.scrollBy(0, control.getBoundingClientRect().top - 10);
			await expect.poll(() => header.getBoundingClientRect().bottom).toBeLessThanOrEqual(0);
			const still = window.scrollY;
			await keyboardFocus(control);
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			expect(window.scrollY).toBe(still);
		} finally {
			holder.remove();
		}
	});

	// The header check is for a control the keyboard left at the window's top edge. A focus that lands while the window
	// is scrolled must not pull the page: Back and Forward (the router focuses the page body without scrolling, after it
	// restores the place), a click into a long passage already partly above the window, a click on a button partly under
	// the header, and a chip that sticks under the header and so cannot move with the page.
	describe('leaves the page where it is when focus lands at 1280 px', () => {
		async function stillAfter(focus: (holder: HTMLElement) => Promise<void> | void, html: string) {
			await openAt(1280, 800);
			const holder = document.createElement('div');
			holder.innerHTML = html;
			(document.querySelector('main') as HTMLElement).prepend(holder);
			try {
				window.scrollTo(0, 600);
				await expect.poll(() => window.scrollY).toBe(600);
				await focus(holder);
				for (let i = 0; i < 4; i++) await new Promise((done) => requestAnimationFrame(done));
				expect(window.scrollY).toBe(600);
			} finally {
				holder.remove();
			}
		}
		const spacer = '<div style="height: 400px"></div>';

		it('on the page body, as after Back or Forward', async () => {
			await stillAfter(async () => {
				document.body.tabIndex = -1;
				await keyboardFocus(document.body);
			}, `${spacer}<div style="height: 1200px"></div>`);
			document.body.removeAttribute('tabindex');
		});

		it('on a long passage already partly above the window', async () => {
			await stillAfter(
				(holder) => keyboardFocus(holder.querySelector('p') as HTMLElement),
				`${spacer}<p tabindex="-1" style="height: 1200px; margin: 0">passage</p>`
			);
		});

		// The page sits so the button's top is 30 px down the window, under the 57 px header; the click hits its lower half.
		it('on a button clicked while partly under the header', async () => {
			await stillAfter(async (holder) => {
				const button = holder.querySelector('button') as HTMLButtonElement;
				expect(button.getBoundingClientRect().top).toBe(30);
				await userEvent.click(button, { position: { x: 5, y: 45 } });
				expect(document.activeElement).toBe(button);
			}, `<div style="height: 549px"></div><button style="height: 60px">press</button><div style="height: 1200px"></div>`);
		});
	});

	// WebKit's Shift+Tab can leave a date field 10 px above the window (setup's leaving date, measured): a control that
	// fits below the header is moved there even when its top is already off the window.
	it('moves a control left partly above the window out from under the header at 1280x800', async () => {
		await openAt(1280, 800);
		const header = document.querySelector('header') as HTMLElement;
		const holder = document.createElement('div');
		holder.innerHTML =
			'<div style="height: 600px"></div><p tabindex="-1" style="height: 42px; margin: 0">control</p><div style="height: 1200px"></div>';
		(document.querySelector('main') as HTMLElement).prepend(holder);
		try {
			const control = holder.querySelector('p') as HTMLElement;
			window.scrollBy(0, control.getBoundingClientRect().top + 10);
			expect(control.getBoundingClientRect().top).toBe(-10);
			await keyboardFocus(control);
			await expect
				.poll(() => control.getBoundingClientRect().top >= header.getBoundingClientRect().bottom)
				.toBe(true);
		} finally {
			holder.remove();
		}
	});

	// WebKit scrolls a control focused by Shift+Tab to the window's top edge only after focusin: the check waits for it.
	it('moves a control out from under the header after the browser scrolls it in late at 1280x800', async () => {
		await openAt(1280, 800);
		const header = document.querySelector('header') as HTMLElement;
		const holder = document.createElement('div');
		holder.innerHTML =
			'<div style="height: 600px"></div><p tabindex="-1" style="height: 24px; margin: 0">control</p><div style="height: 1200px"></div>';
		(document.querySelector('main') as HTMLElement).prepend(holder);
		try {
			const control = holder.querySelector('p') as HTMLElement;
			window.scrollBy(0, control.getBoundingClientRect().top + 300);
			expect(control.getBoundingClientRect().bottom).toBeLessThan(0);
			await keyboardFocus(control);
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			window.scrollBy(0, control.getBoundingClientRect().top);
			await expect
				.poll(() => control.getBoundingClientRect().top >= header.getBoundingClientRect().bottom)
				.toBe(true);
		} finally {
			holder.remove();
		}
	});

	// On a phone the slid-away header comes back on the scroll event the focus scroll itself causes, a moment after
	// focusin: a control the check first saw under a hidden header is moved once the header is back over it.
	it('moves a control out from under the header that comes back after the focus at 320x640', async () => {
		await openAt(320, 640);
		const header = document.querySelector('header') as HTMLElement;
		const holder = document.createElement('div');
		holder.innerHTML =
			'<div style="height: 600px"></div><p tabindex="-1" style="height: 24px; margin: 0">control</p><div style="height: 1200px"></div>';
		(document.querySelector('main') as HTMLElement).prepend(holder);
		try {
			const control = holder.querySelector('p') as HTMLElement;
			window.scrollBy(0, control.getBoundingClientRect().top - 15);
			await expect.poll(() => header.hasAttribute('data-hidden')).toBe(true);
			await keyboardFocus(control);
			window.scrollBy(0, -5);
			await expect.poll(() => header.hasAttribute('data-hidden')).toBe(false);
			await expect
				.poll(() => control.getBoundingClientRect().top >= header.offsetHeight)
				.toBe(true);
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

	// The late check gives up after about half a second: a control that keeps focus without being scrolled to (a focus that
	// asked not to scroll, or the window coming back) must not pull the page when the person later scrolls by hand.
	it('leaves a later hand scroll alone once the late check has given up at 320 px', async () => {
		await openAt(320, 568);
		const last = [...document.querySelectorAll<HTMLAnchorElement>('footer a')].at(
			-1
		) as HTMLElement;
		const bar = document.querySelector('.bottom-bar') as HTMLElement;
		last.focus({ preventScroll: true });
		for (let i = 0; i < 40; i++) await new Promise((done) => requestAnimationFrame(done));
		window.scrollBy(0, last.getBoundingClientRect().top - (bar.getBoundingClientRect().top - 11));
		const handScroll = window.scrollY;
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
		expect(window.scrollY).toBe(handScroll);
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

	// From 600 px the header carries the menu: at 200 % text the brand and the links no longer fit one line, so the
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

	// While focus is in the header it stays on screen, so the page must not be told it is hidden: the Timeline's sticky
	// chips take the header's place when it is, and would slide under the header instead.
	it('does not flag the header hidden while focus is in it and the page scrolls down at 320x640', async () => {
		await openAt(320, 640);
		(document.querySelector('header a.brand') as HTMLElement).focus();
		window.scrollTo(0, 600);
		await expect.poll(() => window.scrollY).toBe(600);
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
		expect(document.documentElement.hasAttribute('data-header-hidden')).toBe(false);
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
