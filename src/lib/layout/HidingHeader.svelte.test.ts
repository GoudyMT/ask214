import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { cdp, page, userEvent } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfileStore } from '$lib/profile/store.svelte';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import Layout from '../../routes/+layout.svelte';

// The real layout starts up on a test database with a saved profile; only the database it opens is pointed at the
// test one.
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
	render: () => '<div style="height: 3000px"><a href="#top-of-page">first</a></div>'
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
	history.replaceState(null, '', location.pathname + location.search);
	window.scrollTo(0, 0);
	await page.viewport(restoreSize.width, restoreSize.height);
	if (db) await deleteTestDb(db);
	db = null;
});

async function openAt(width: number, height: number): Promise<void> {
	await page.viewport(width, height);
	await render(Layout, { children });
	await expect
		.poll(() =>
			[...document.querySelectorAll('a')].some((a) => a.textContent?.trim() === 'Settings')
		)
		.toBe(true);
}

const header = () => document.querySelector('header') as HTMLElement;
const main = () => document.querySelector('main') as HTMLElement;
const isHidden = () => header().hasAttribute('data-hidden');
const flagOnRoot = () => document.documentElement.hasAttribute('data-header-hidden');
const frames = () =>
	new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

describe('the phone header while the page scrolls', () => {
	// Reading down a long page, the header is in the way; the first move back up is a person looking for the menu.
	it('slides away on a scroll down and comes back on a short scroll up at 320 px', async () => {
		await openAt(320, 568);
		expect(isHidden()).toBe(false);
		window.scrollTo(0, 200);
		await expect.poll(isHidden).toBe(true);
		expect(flagOnRoot()).toBe(true);

		window.scrollBy(0, -20);
		await expect.poll(isHidden).toBe(false);
		expect(flagOnRoot()).toBe(false);
	});

	// A keyboard user who tabs back up to the brand link must see where focus is. The browser usually scrolls the page up
	// to a focused control, and that scroll would show the header by itself (Shift+Tab alone cannot tell the two rules
	// apart); focus that moves with no scroll is the case this rule exists for.
	it('comes back when focus enters it, with no scroll to bring it back', async () => {
		await openAt(320, 568);
		window.scrollTo(0, 200);
		await expect.poll(isHidden).toBe(true);
		const scrolls = vi.fn();
		window.addEventListener('scroll', scrolls);
		(header().querySelector('a.brand') as HTMLAnchorElement).focus({ preventScroll: true });
		await expect.poll(isHidden).toBe(false);
		window.removeEventListener('scroll', scrolls);
		expect(scrolls).not.toHaveBeenCalled();
	});

	// The header focus brought back counts its 12 px from where the person is now, as a freshly shown header does: a
	// tiny scroll down right after must not slide it away again.
	it('stays after focus brought it back and the page moves down 5 px at 320 px', async () => {
		await openAt(320, 568);
		window.scrollTo(0, 200);
		await expect.poll(isHidden).toBe(true);
		(header().querySelector('a.brand') as HTMLAnchorElement).focus({ preventScroll: true });
		await expect.poll(isHidden).toBe(false);
		window.scrollBy(0, 5);
		await expect.poll(() => window.scrollY).toBe(205);
		await frames();
		expect(isHidden()).toBe(false);
	});

	it('does not hide on a wide screen, however far the page is scrolled', async () => {
		await openAt(1280, 800);
		window.scrollTo(0, 200);
		await expect.poll(() => window.scrollY).toBe(200);
		await frames();
		expect(isHidden()).toBe(false);
		expect(flagOnRoot()).toBe(false);
	});

	// The bar is gone from 600 px, and the header's menu is the only menu: the header hides only where the bar shows, so
	// at exactly 600 px it stays however far the page is scrolled.
	it('does not hide at exactly 600 px, where the bar is gone', async () => {
		await openAt(600, 800);
		window.scrollTo(0, 200);
		await expect.poll(() => window.scrollY).toBe(200);
		await frames();
		expect(isHidden()).toBe(false);
		expect(flagOnRoot()).toBe(false);
	});

	// Someone who asked their device for less motion gets the header gone and back with no slide.
	it('slides in 200 ms, and not at all when reduced motion is on', async () => {
		await openAt(320, 568);
		expect(getComputedStyle(header()).transitionDuration).toBe('0.2s');
		const session = cdp();
		await session.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
		});
		try {
			await expect.poll(() => matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
			expect(getComputedStyle(header()).transitionDuration).toBe('0s');
		} finally {
			await session.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
			});
		}
	});

	// Hiding must not reflow the page: if the header's box collapsed, the text under it would jump up as it left.
	it('moves the header off screen by transform alone, leaving its height and the page in place', async () => {
		await openAt(320, 568);
		const before = { height: header().getBoundingClientRect().height, mainTop: main().offsetTop };
		window.scrollTo(0, 200);
		await expect.poll(isHidden).toBe(true);
		await expect.poll(() => header().getBoundingClientRect().bottom).toBeLessThanOrEqual(0);
		expect(header().getBoundingClientRect().height).toBe(before.height);
		expect(main().offsetTop).toBe(before.mainTop);
		expect(new DOMMatrixReadOnly(getComputedStyle(header()).transform).m42).toBe(-before.height);
	});

	// A phone turned to landscape (or any window grown past 600 px) while the header is hidden has no bottom bar any more:
	// the top menu is the only way around, so it must be back, and must behave as on a wide screen from then on.
	it('shows the header again when the width crosses 600 px, and stops hiding it', async () => {
		await openAt(320, 568);
		window.scrollTo(0, 200);
		await expect.poll(isHidden).toBe(true);

		await page.viewport(1280, 800);
		await expect.poll(isHidden).toBe(false);
		expect(flagOnRoot()).toBe(false);

		window.scrollTo(0, 600);
		await expect.poll(() => window.scrollY).toBe(600);
		await frames();
		expect(isHidden()).toBe(false);
		expect(flagOnRoot()).toBe(false);
	});

	// The Timeline, the task cards and the SkillBridge status line tune their own scroll-margin-top (6.5rem) so a jump
	// lands just under the sticky chips; the room kept for the phone header must not be added on top of it.
	it('leaves an element with scroll-margin-top 6.5rem at 104 px when scrolled to at 320 px', async () => {
		await openAt(320, 568);
		const target = document.createElement('div');
		target.style.cssText =
			'position: absolute; top: 1500px; height: 40px; scroll-margin-top: 6.5rem';
		document.body.appendChild(target);
		try {
			target.scrollIntoView({ block: 'start' });
			await expect
				.poll(() => Math.abs(target.getBoundingClientRect().top - 104))
				.toBeLessThanOrEqual(1);
		} finally {
			target.remove();
		}
	});

	// "Skip to content" lands the main region at the top of the screen: it must clear the header that sits there.
	it('puts the main region below the header after "Skip to content" at 320 px', async () => {
		await openAt(320, 568);
		window.scrollTo(0, 500);
		await expect.poll(isHidden).toBe(true);
		(document.querySelector('.skip-link') as HTMLElement).focus({ preventScroll: true });
		await userEvent.keyboard('{Enter}');
		await expect.poll(() => window.scrollY).toBeLessThan(100);
		await expect
			.poll(() => main().getBoundingClientRect().top - header().getBoundingClientRect().bottom)
			.toBeGreaterThanOrEqual(0);
	});
});
