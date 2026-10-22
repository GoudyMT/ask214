import '../../app.css';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
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
const currentLabels = (container: Element) =>
	links(container)
		.filter((a) => a.getAttribute('aria-current') === 'page')
		.map((a) => a.textContent?.trim());

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

	// The wizard owns no tab; Settings, Resources, Documents, Feedback and About are under More.
	it.each([
		['/', 'Home'],
		['/skillbridge', 'SkillBridge'],
		['/settings', 'More']
	])('marks only %s as the current page: %s', async (pathname, label) => {
		route.pathname = pathname;
		const { container } = await render(BottomBar);
		expect(currentLabels(container)).toEqual([label]);
	});

	it('marks no tab on a page no tab owns', async () => {
		route.pathname = '/wizard';
		const { container } = await render(BottomBar);
		expect(currentLabels(container)).toEqual([]);
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
