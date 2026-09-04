import { expect, test, type Page } from '@playwright/test';

// Responsive coverage across the app's primary surfaces. The shell unifies to a single 900px
// max-width across every route (shell-width.ts), so on wide viewports <main> is capped at 900px
// and on narrow viewports (<= 900px) it equals the viewport width.
//
// The load-bearing check at MOBILE widths is horizontal overflow: a route that pushes content
// past the viewport (a wide table, an unwrapped string, a fixed-width element) horizontal-scrolls
// the whole page - which the <= 900px main check alone cannot catch on a 320px screen (main is
// already <= 900 there).

/**
 * Assert the document does not scroll horizontally, and NAME what does when it fails.
 *
 * The bare assertion reported a single integer. `/timeline` at 320px has failed on CI four times with
 * exactly 7px - three branches and `main` - and every failure gave the same number and no lead, while the
 * overflow is not reproducible on a Windows dev machine (CI runs Linux, where the system font stack
 * resolves differently and text measures wider). A number cannot be diagnosed; an element can.
 *
 * The walk runs ONLY once overflow is already non-zero, so a green run costs nothing. Elements inside a
 * horizontal scroll container are skipped: the phase-chip strip legitimately extends past the viewport
 * and is a red herring that has already cost one investigation.
 *
 * The assertion and its threshold are unchanged - this adds a failure message, nothing else. It is
 * deliberately NOT a poll: four failures at an identical 7px is the opposite of a timing race, and
 * retrying until it passes would bury a real 320px overflow rather than fix it.
 *
 * @param page The page under test, already navigated and settled.
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
	// scrollWidth (content incl. overflow) must not exceed clientWidth (viewport minus any scrollbar).
	// clientWidth is scrollbar-safe, so a vertical scrollbar does not false-positive here.
	const { overflow, culprits } = await page.evaluate(() => {
		const doc = document.documentElement;
		const amount = doc.scrollWidth - doc.clientWidth;
		if (amount <= 0) return { overflow: amount, culprits: [] as string[] };

		const vw = doc.clientWidth;
		const found: string[] = [];
		for (const el of Array.from(doc.querySelectorAll('*'))) {
			const r = el.getBoundingClientRect();
			if (r.right <= vw + 0.5 || r.width < 2) continue;
			let clipped = false;
			for (let p = el.parentElement; p; p = p.parentElement) {
				const ox = getComputedStyle(p).overflowX;
				if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') {
					clipped = true;
					break;
				}
			}
			if (clipped) continue;
			const e = el as HTMLElement;
			const cls = String(e.className || '').trim();
			found.push(
				`${e.tagName.toLowerCase()}${cls ? '.' + cls.split(/\s+/).join('.') : ''}` +
					` right=${r.right.toFixed(1)} width=${r.width.toFixed(1)}` +
					` text=${JSON.stringify((e.textContent ?? '').trim().slice(0, 60))}`
			);
		}
		return { overflow: amount, culprits: found.slice(0, 10) };
	});

	const detail = culprits.length
		? `\noverflowing elements (viewport exceeded by ${overflow}px):\n  ${culprits.join('\n  ')}`
		: `\noverflow is ${overflow}px but no unclipped element exceeds the viewport - suspect a margin, ` +
			`a transform, or an element the walk skipped as clipped.`;
	expect(overflow, detail).toBeLessThanOrEqual(0);
}
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

			await expectNoHorizontalOverflow(page);
		});
	}
}

// Profile-gated routes: the widest post-setup surfaces (task cards + the phase-chip row + the calendar
// card on /timeline; the EAOS edit + BYO-key panel on /settings). They render only with a provisioned
// profile, so the public loop above never reaches them - which is exactly where a long task title or a
// fixed-width control can overflow a 320px screen. Provision via the wizard, then check overflow.
const EAOS = '2027-04-15';
async function setEaos(page: Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(EAOS);
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

const GATED_ROUTES = ['/timeline', '/settings'];
for (const route of GATED_ROUTES) {
	for (const vp of MOBILE) {
		test(`${route} (with profile) - no horizontal overflow at ${vp.width}x${vp.height} (${vp.label})`, async ({
			page
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height });
			await setEaos(page);
			await page.goto(route);

			await expect(page.getByRole('main')).toBeVisible();
			await expectNoHorizontalOverflow(page);
		});
	}
}
