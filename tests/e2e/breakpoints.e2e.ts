import { expect, test } from '@playwright/test';

// Responsive coverage across the app's primary surfaces. The shell unifies to a single 900px
// max-width across every route (shell-width.ts), so on wide viewports <main> is capped at 900px
// and on narrow viewports (<= 900px) it equals the viewport width.
//
// The load-bearing check at MOBILE widths is horizontal overflow: a route that pushes content
// past the viewport (a wide table, an unwrapped string, a fixed-width element) horizontal-scrolls
// the whole page - which the <= 900px main check alone cannot catch on a 320px screen (main is
// already <= 900 there).
const MOBILE = [
	{ width: 320, height: 568, label: 'iPhone SE' },
	{ width: 375, height: 667, label: 'iPhone 8' },
	{ width: 414, height: 896, label: 'iPhone Plus' }
];
const WIDER = [
	{ width: 768, height: 1024, label: 'iPad portrait' },
	{ width: 1024, height: 768, label: 'iPad landscape' },
	{ width: 1280, height: 800, label: 'Desktop' }
];

// Public routes reachable without a provisioned profile. Home gets the full width range (the
// primary surface); the rest are checked at mobile widths, where overflow bites. (/ask is a 308
// redirect to Home -- the Ask UI lives on / , already covered -- so listing it would retest Home.)
const ROUTES = ['/', '/resources', '/about', '/feedback', '/wizard'];

for (const route of ROUTES) {
	const viewports = route === '/' ? [...MOBILE, ...WIDER] : MOBILE;
	for (const vp of viewports) {
		test(`${route} - landmarks render, no horizontal overflow at ${vp.width}x${vp.height} (${vp.label})`, async ({
			page
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height });
			await page.goto(route);

			await expect(page.getByRole('banner')).toBeVisible();
			await expect(page.getByRole('main')).toBeVisible();
			await expect(page.getByRole('contentinfo')).toBeVisible();

			const mainWidth = await page
				.getByRole('main')
				.evaluate((el) => el.getBoundingClientRect().width);
			expect(mainWidth).toBeLessThanOrEqual(900);

			// No horizontal scroll: scrollWidth (content incl. overflow) must not exceed clientWidth
			// (viewport minus any scrollbar). clientWidth is scrollbar-safe, so a vertical scrollbar
			// does not false-positive here.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			);
			expect(overflow).toBeLessThanOrEqual(0);
		});
	}
}
