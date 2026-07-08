import { expect, test } from '@playwright/test';

// Six viewports covering the responsive range. The app shell unified to a single
// responsive 900px max-width across every route (shell-width.ts), superseding the old
// 720px. With box-sizing border-box, <main>'s getBoundingClientRect width never exceeds 900px on wide
// viewports; on narrow viewports (<= 900px) it equals the viewport width. Either way, <= 900 holds.
const viewports = [
	{ width: 320, height: 568, label: 'iPhone SE' },
	{ width: 375, height: 667, label: 'iPhone 8' },
	{ width: 414, height: 896, label: 'iPhone Plus' },
	{ width: 768, height: 1024, label: 'iPad portrait' },
	{ width: 1024, height: 768, label: 'iPad landscape' },
	{ width: 1280, height: 800, label: 'Desktop' }
];

for (const vp of viewports) {
	test(`landmarks render and content stays within 900px at ${vp.width}x${vp.height} (${vp.label})`, async ({
		page
	}) => {
		await page.setViewportSize({ width: vp.width, height: vp.height });
		await page.goto('/');

		await expect(page.getByRole('banner')).toBeVisible();
		await expect(page.getByRole('main')).toBeVisible();
		await expect(page.getByRole('contentinfo')).toBeVisible();

		const mainWidth = await page
			.getByRole('main')
			.evaluate((el) => el.getBoundingClientRect().width);
		expect(mainWidth).toBeLessThanOrEqual(900);
	});
}
