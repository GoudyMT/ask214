import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sealApi, setUpTimeline } from './helpers/backup';

// The phone bottom bar (below 600px) and the top menu (from 600px), checked in real browsers at real widths: that the
// bar takes a person to every page, never covers what they read, type or focus, survives forced colours, and leaves
// the page free of accessibility violations. Phone sizes are set per test because the projects are desktop browsers.

const PHONE = { width: 320, height: 568 };
const DESKTOP = { width: 1280, height: 800 };

const BAR = 'nav.bottom-bar';

// The bar's four tabs, in order. The home heading is the hero line, so it is matched loosely.
const TABS: { name: string; path: string; heading: string | RegExp }[] = [
	{ name: 'Home', path: '/', heading: /military transition/i },
	{ name: 'Timeline', path: '/timeline', heading: 'Timeline' },
	{ name: 'SkillBridge', path: '/skillbridge', heading: 'SkillBridge' },
	{ name: 'More', path: '/more', heading: 'More' }
];

// The More page's internal rows. Feedback's page is titled "Send feedback".
const MORE_ROWS: { name: string; path: string; heading: string }[] = [
	{ name: 'Settings', path: '/settings', heading: 'Settings' },
	{ name: 'Resources', path: '/resources', heading: 'Resources' },
	{ name: 'Documents', path: '/documents', heading: 'Documents' },
	{ name: 'Feedback', path: '/feedback', heading: 'Send feedback' },
	{ name: 'About', path: '/about', heading: 'About' }
];

// The top menu from 600px. Settings is there once the app is ready, which a saved timeline makes it.
const MENU: { name: string; path: string; heading: string }[] = [
	{ name: 'Timeline', path: '/timeline', heading: 'Timeline' },
	{ name: 'SkillBridge', path: '/skillbridge', heading: 'SkillBridge' },
	{ name: 'Resources', path: '/resources', heading: 'Resources' },
	{ name: 'Settings', path: '/settings', heading: 'Settings' }
];

// A route may or may not end in a slash depending on how it was reached; the page is what matters.
function at(path: string): (url: URL) => boolean {
	const bare = (p: string) => p.replace(/\/$/, '') || '/';
	return (url) => bare(url.pathname) === bare(path);
}

async function expectPage(page: Page, path: string, heading: string | RegExp): Promise<void> {
	await expect(page).toHaveURL(at(path));
	await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

// Positions settle late (WebKit applies a focus scroll after the event), so the check polls until the target clears
// the bar and fails with both edges if it never does.
async function expectClearOfBar(page: Page, target: Locator): Promise<void> {
	const bar = page.locator(BAR);
	await expect
		.poll(
			async () => {
				const [t, b] = await Promise.all([target.boundingBox(), bar.boundingBox()]);
				if (!t || !b) return 'missing';
				const bottom = t.y + t.height;
				return bottom <= b.y ? 'clear' : `covered: target bottom ${bottom}, bar top ${b.y}`;
			},
			{ timeout: 5000 }
		)
		.toBe('clear');
}

test('a person on a phone reaches every page from the bottom bar, and More keeps its pages', async ({
	page,
	context
}) => {
	await page.setViewportSize(PHONE);
	await sealApi(context, page);
	await setUpTimeline(page);
	const bar = page.locator(BAR);
	await expect(bar).toBeVisible();
	// Every tab is there with its visible label, and none is hidden from a screen reader.
	await expect(bar.getByRole('link')).toHaveText(TABS.map((tab) => tab.name));

	for (const tab of TABS) {
		await bar.getByRole('link', { name: tab.name, exact: true }).click();
		await expectPage(page, tab.path, tab.heading);
		// Exactly one tab is current and it is the one just tapped.
		await expect(bar.locator('a[aria-current="page"]')).toHaveCount(1);
		await expect(bar.getByRole('link', { name: tab.name, exact: true })).toHaveAttribute(
			'aria-current',
			'page'
		);
	}

	// The placeholder sends a person to the official site rather than leaving them at a dead end.
	await bar.getByRole('link', { name: 'SkillBridge', exact: true }).click();
	await expect(page.getByRole('link', { name: 'DoD SkillBridge site' })).toHaveAttribute(
		'href',
		'https://skillbridge.osd.mil/'
	);

	for (const row of MORE_ROWS) {
		await bar.getByRole('link', { name: 'More', exact: true }).click();
		await expectPage(page, '/more', 'More');
		await page.getByRole('main').getByRole('link', { name: row.name }).click();
		await expectPage(page, row.path, row.heading);
		// These pages live under More, so the tab stays marked as the current section (not the current page) while a
		// person is on one.
		await expect(bar.locator('a[aria-current]')).toHaveCount(1);
		await expect(bar.getByRole('link', { name: 'More', exact: true })).toHaveAttribute(
			'aria-current',
			'true'
		);
	}
});

test('a person on a desktop reaches every page from the top menu', async ({ page, context }) => {
	await page.setViewportSize(DESKTOP);
	await sealApi(context, page);
	await setUpTimeline(page);
	await page.goto('/');

	const menu = page.getByRole('banner').getByRole('navigation', { name: 'Primary' });
	await expect(menu).toBeVisible();

	for (const item of MENU) {
		await menu.getByRole('link', { name: item.name, exact: true }).click();
		await expectPage(page, item.path, item.heading);
	}

	// Resources moved nowhere: its address still answers.
	const response = await page.goto('/resources');
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading', { level: 1, name: 'Resources' })).toBeVisible();
});

// 599 and 600 wide are one pixel apart and must not leave a person with no menu, or with two.
for (const [width, where] of [
	[599, 'bottom bar'],
	[600, 'header menu']
] as const) {
	test(`at ${width}px wide the ${where} is the one Primary menu`, async ({ page, context }) => {
		await page.setViewportSize({ width, height: 800 });
		await sealApi(context, page);
		await page.goto('/');
		const primary = page.getByRole('navigation', { name: 'Primary' });
		await expect(primary).toHaveCount(1);
		const bar = page.locator(BAR);
		if (width < 600) await expect(bar).toBeVisible();
		else await expect(bar).toBeHidden();
		await expect(primary).toBeVisible();
	});
}

// 400% zoom of a 1280px window is a 320px-wide, 180px-tall page. The footer is the last thing on a page, so it is where
// the bar would hide content for good.
for (const route of ['/', '/more']) {
	test(`${route} at 320x180 has its last footer link clear of the bar`, async ({
		page,
		context,
		browserName
	}) => {
		await page.setViewportSize({ width: 320, height: 180 });
		await sealApi(context, page);
		await page.goto(route);
		await expect(page.locator(BAR)).toBeVisible();

		const last = page.getByRole('contentinfo').getByRole('link').last();
		if (browserName === 'webkit') {
			// WebKit leaves links out of the Tab order (as Safari does without its link-tabbing option), so the
			// key cannot reach the link there; focusing it scrolls it into view the same way.
			await last.focus();
		} else {
			// The footer's last link is the last stop in the page: Tab from the one before it.
			const footerLinks = page.getByRole('contentinfo').getByRole('link');
			await footerLinks.nth((await footerLinks.count()) - 2).focus();
			await page.keyboard.press('Tab');
		}
		await expect(last).toBeFocused();
		await expectClearOfBar(page, last);
	});
}

// A person typing a question must see what they type. The second height stands in for a browser that shrinks the page
// when the on-screen keyboard opens.
for (const height of [568, 300]) {
	test(`the question field stays above the bottom bar when focused at 320x${height}`, async ({
		page,
		context
	}) => {
		await page.setViewportSize({ width: 320, height });
		await sealApi(context, page);
		await page.goto('/');
		await expect(page.locator(BAR)).toBeVisible();
		const field = page.locator('.ask-input');
		await field.focus();
		await expect(field).toBeFocused();
		await expectClearOfBar(page, field);
	});
}

// Forced colours replace the palette, so the current tab cannot rely on colour alone: its 3px top border must remain
// and the other tabs must have none.
for (const [route, current] of [
	['/', 'Home'],
	['/more', 'More']
] as const) {
	test(`in forced colours the bar marks ${current} with a 3px top border on ${route}`, async ({
		page,
		context,
		browserName
	}) => {
		test.skip(browserName !== 'chromium', 'forced-colors emulation is Chromium only');
		await page.setViewportSize(PHONE);
		await sealApi(context, page);
		await page.emulateMedia({ forcedColors: 'active' });
		await page.goto(route);
		// Without this the check below would pass on an unemulated page.
		expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
		await expect(page.locator(BAR)).toBeVisible();
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

		const widths = await page.locator(`${BAR} a`).evaluateAll((links) =>
			links.map((link) => ({
				name: (link.textContent ?? '').trim(),
				width: getComputedStyle(link).borderTopWidth
			}))
		);
		expect(widths).toEqual(
			TABS.map((tab) => ({ name: tab.name, width: tab.name === current ? '3px' : '0px' }))
		);
	});
}

// axe-core runs inside the page. The app's content security policy blocks an injected script, so these checks (and no
// others) use a context that bypasses it; the app itself is unchanged.
const AXE_PATH = createRequire(join(process.cwd(), 'package.json')).resolve('axe-core/axe.min.js');

type AxeViolation = {
	id: string;
	impact?: string | null;
	nodes: { target: unknown[]; any: { message: string }[] }[];
};

const AXE_PAGES: { path: string; heading: string | RegExp; needsTimeline: boolean }[] = [
	{ path: '/', heading: /military transition/i, needsTimeline: false },
	{ path: '/timeline', heading: 'Timeline', needsTimeline: true },
	{ path: '/more', heading: 'More', needsTimeline: false },
	{ path: '/skillbridge', heading: 'SkillBridge', needsTimeline: false }
];

for (const width of [320, 1280]) {
	for (const colorScheme of ['light', 'dark'] as const) {
		test.describe(`axe at ${width}px, ${colorScheme}`, () => {
			test.use({
				bypassCSP: true,
				colorScheme,
				viewport: { width, height: width === 320 ? 568 : 800 }
			});

			for (const entry of AXE_PAGES) {
				test(`${entry.path} has no accessibility violations`, async ({ page, context }) => {
					await sealApi(context, page);
					if (entry.needsTimeline) await setUpTimeline(page);
					await page.goto(entry.path);
					await expect(page.getByRole('heading', { level: 1, name: entry.heading })).toBeVisible();
					await page.addScriptTag({ path: AXE_PATH });
					const violations = await page.evaluate(async () => {
						const axe = (
							window as unknown as {
								axe: { run: (c: Document) => Promise<{ violations: AxeViolation[] }> };
							}
						).axe;
						const result = await axe.run(document);
						return result.violations.map((v) => ({
							id: v.id,
							impact: v.impact ?? null,
							targets: v.nodes.map((n) => n.target.map(String).join(' ')),
							// The measured detail (a contrast ratio and both colours) is what a fix needs.
							messages: v.nodes.flatMap((n) => n.any.map((a) => a.message))
						}));
					});
					expect(violations).toEqual([]);
				});
			}
		});
	}
}
