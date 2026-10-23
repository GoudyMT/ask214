import '../../app.css';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import BottomBar from './BottomBar.svelte';

// The bar reads the open page's path from the router; a test sets the path it wants before it renders.
const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return new URL(route.pathname, 'https://ask214.test');
		}
	}
}));

const PHONE = { width: 320, height: 568 };
let restoreSize = { width: 0, height: 0 };

beforeEach(async () => {
	route.pathname = '/';
	restoreSize = { width: window.innerWidth, height: window.innerHeight };
	await page.viewport(PHONE.width, PHONE.height);
});
afterEach(async () => {
	await page.viewport(restoreSize.width, restoreSize.height);
});

const links = (container: Element) => [
	...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Primary"] a')
];
// Every tab marked as current, with how it is marked.
const marked = (container: Element) =>
	links(container)
		.filter((a) => a.hasAttribute('aria-current'))
		.map((a) => [a.textContent?.trim(), a.getAttribute('aria-current')]);

describe('BottomBar on a 320 px phone', () => {
	// A person on a phone sees every place by name, so they never have to guess an icon.
	it('shows Home, Timeline, SkillBridge and More in that order, each with its visible label', async () => {
		const { container } = await render(BottomBar);
		const bar = container.querySelector('nav') as HTMLElement;
		expect(getComputedStyle(bar).display).not.toBe('none');
		expect(links(container).map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
			['Home', '/'],
			['Timeline', '/timeline'],
			['SkillBridge', '/skillbridge'],
			['More', '/more']
		]);
		for (const a of links(container)) {
			const label = a.querySelector('span') as HTMLElement;
			expect(label.getBoundingClientRect().height).toBeGreaterThan(0);
			expect(parseFloat(getComputedStyle(label).fontSize)).toBeGreaterThanOrEqual(12);
		}
	});

	// A thumb needs a target of at least 56 px, four equal columns so no tab is harder to hit, and icons that stay put
	// when the marked tab changes (the mark must not push its own icon down).
	it('gives each tab a 56 px tall equal column, with the icons level whichever tab is current', async () => {
		const { container } = await render(BottomBar);
		const boxes = links(container).map((a) => a.getBoundingClientRect());
		expect(boxes).toHaveLength(4);
		for (const box of boxes) {
			expect(box.height).toBeGreaterThanOrEqual(56);
			expect(box.width).toBeCloseTo(PHONE.width / 4, 0);
		}
		// The longest label fits its column, so it never wraps and makes one tab taller than the rest.
		for (const a of links(container)) expect(a.scrollWidth).toBeLessThanOrEqual(a.clientWidth);
		const iconTops = links(container).map(
			(a) => (a.querySelector('svg') as SVGElement).getBoundingClientRect().top
		);
		expect(new Set(iconTops).size).toBe(1);
	});

	// A person who raised their text size (Android font size, text-only zoom) still reads every label: a long one wraps
	// inside its own column instead of running over the next tab or off the screen.
	it('keeps every label inside its own column at a large text size', async () => {
		const root = document.documentElement;
		const before = root.style.getPropertyValue('--font-size-s');
		root.style.setProperty('--font-size-s', '28px');
		try {
			const { container } = await render(BottomBar);
			const bar = (container.querySelector('nav') as HTMLElement).getBoundingClientRect();
			const labels = links(container).map((a) =>
				(a.querySelector('span') as HTMLElement).getBoundingClientRect()
			);
			expect(labels).toHaveLength(4);
			for (const label of labels) {
				expect(label.left).toBeGreaterThanOrEqual(bar.left);
				expect(label.right).toBeLessThanOrEqual(bar.right);
			}
			for (const [i, label] of labels.entries()) {
				const next = labels[i + 1];
				if (next) expect(label.right).toBeLessThanOrEqual(next.left);
			}
		} finally {
			if (before) root.style.setProperty('--font-size-s', before);
			else root.style.removeProperty('--font-size-s');
		}
	});

	// The bar touches the left, right and bottom edges of the screen, so a focus ring drawn outside the tab would be cut
	// off there: a keyboard user must see the whole ring.
	it('draws the focus ring of the first tab inside the screen', async () => {
		const { container } = await render(BottomBar);
		await userEvent.tab();
		const home = links(container)[0] as HTMLElement;
		expect(document.activeElement).toBe(home);
		expect(home.matches(':focus-visible')).toBe(true);
		const rect = home.getBoundingClientRect();
		const style = getComputedStyle(home);
		const offset = parseFloat(style.outlineOffset);
		const width = parseFloat(style.outlineWidth);
		expect(rect.left - offset - width).toBeGreaterThanOrEqual(0);
		expect(rect.bottom + offset + width).toBeLessThanOrEqual(window.innerHeight);
	});

	// The wizard owns no tab; Settings, Resources, Documents, Feedback and About are under More. A screen reader says
	// "current page" only for the tab whose page is open; for More behind it, it is the current section.
	it.each([
		['/', 'Home', 'page'],
		['/skillbridge', 'SkillBridge', 'page'],
		['/more', 'More', 'page'],
		['/settings', 'More', 'true']
	])('marks only %s as the current tab: %s, %s', async (pathname, label, how) => {
		route.pathname = pathname;
		const { container } = await render(BottomBar);
		expect(marked(container)).toEqual([[label, how]]);
	});

	it('marks no tab on a page no tab owns', async () => {
		route.pathname = '/wizard';
		const { container } = await render(BottomBar);
		expect(marked(container)).toEqual([]);
	});

	// Marked as the section only for the screen reader: the look of the current tab holds on every page behind More.
	it('draws the 3 px top bar on More while a page behind it is open', async () => {
		route.pathname = '/settings';
		const { container } = await render(BottomBar);
		const more = links(container).at(-1) as HTMLElement;
		expect(more.textContent?.trim()).toBe('More');
		expect(getComputedStyle(more).borderTopWidth).toBe('3px');
		expect(getComputedStyle(more).borderTopStyle).toBe('solid');
	});

	// In normal colours the current tab is told apart by its accent colour and bold label (and its top bar, below).
	it('shows the current tab in the accent colour with a 600 weight label, and the others plain', async () => {
		route.pathname = '/timeline';
		const { container } = await render(BottomBar);
		// The accent is a theme token, so read what it resolves to rather than a colour written here.
		const probe = document.createElement('div');
		probe.style.color = 'var(--color-accent)';
		container.appendChild(probe);
		const accent = getComputedStyle(probe).color;
		probe.remove();
		const [home, timeline] = links(container).map((a) => getComputedStyle(a));
		expect(timeline?.color).toBe(accent);
		expect(timeline?.fontWeight).toBe('600');
		expect(home?.color).not.toBe(accent);
		expect(home?.fontWeight).not.toBe('600');
	});

	// Forced colours drop the accent text colour, so the marked tab would look like the rest; its 3 px top bar is what
	// still tells it apart. The other tabs draw no border at all, which forced colours would colour in as well.
	it('keeps a 3 px top bar on the current tab alone when forced colours are on', async () => {
		route.pathname = '/timeline';
		const { container } = await render(BottomBar);
		const tops = () =>
			links(container).map((a) => {
				const s = getComputedStyle(a);
				return s.borderTopStyle === 'none' ? 'none' : s.borderTopWidth;
			});
		const session = cdp();
		await session.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'forced-colors', value: 'active' }]
		});
		try {
			await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(true);
			expect(tops()).toEqual(['none', '3px', 'none', 'none']);
		} finally {
			await session.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'none' }]
			});
		}
		await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(false);
	});
});
