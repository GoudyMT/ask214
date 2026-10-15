import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { SHELL_BYTES_ALLOWANCE } from '../../src/lib/ci/chunk-budget-policy';

// Pages open offline from the page the worker keeps at install: after a first visit, whose own page load came
// before the worker could keep it, and after an update, whose install keeps a fresh copy while the release before
// it is deleted. A page never opened while the worker was in charge takes the same path as every page does after
// an update.
//
// Chromium only. Under Playwright's WebKit, `context.setOffline(true)` fails every request from a page the worker
// controls before the worker can answer it, so no offline page can load there whatever the app does. Real iOS
// Safari is covered by the release gate's device smoke.
test.skip(
	({ browserName }) => browserName === 'webkit',
	'Playwright WebKit offline fails a worker-controlled request before the worker can answer it'
);

async function workerInCharge(page: import('@playwright/test').Page): Promise<void> {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise<void>((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
					once: true
				})
			);
	});
}

// Erase keeps the app's own code, so the app still opens offline afterwards; everything else in Cache Storage goes.
test('after an erase, pages never opened still open offline and the asset cache is gone', async ({
	page,
	context
}) => {
	await page.goto('/');
	await workerInCharge(page);
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
	await page.evaluate(async () => {
		await (await caches.open('ask-assets-v1')).put('/docs/a.1.pdf', new Response('doc'));
	});

	await page.goto('/settings');
	await expect(page.getByText('Apr 15, 2027')).toBeVisible();
	await page.getByRole('button', { name: /erase all data on this device/i }).click();
	// The date leaves the screen at the relock, the erase's first step; the caches are cleared just before its last,
	// the reload, so the reload is what to wait for.
	const reloaded = page.waitForEvent('load', { timeout: 15_000 });
	await page.getByRole('button', { name: /^erase everything$/i }).click();
	await reloaded;
	await expect(page.getByText('Apr 15, 2027')).toBeHidden();
	await workerInCharge(page);

	// The reloaded page opens the asset cache again to read whether the device is set up, so its name may come
	// back; what must not come back is anything in it.
	const leftOutsideAppCode = await page.evaluate(async () => {
		const left: string[] = [];
		for (const name of await caches.keys()) {
			if (name.startsWith('app-')) continue;
			for (const request of await (await caches.open(name)).keys())
				left.push(`${name} ${new URL(request.url).pathname}`);
		}
		return left;
	});
	expect(leftOutsideAppCode).toEqual([]);
	const pagesKept = await page.evaluate(async () => {
		const kept: string[] = [];
		for (const name of await caches.keys())
			for (const request of await (await caches.open(name)).keys())
				kept.push(new URL(request.url).pathname);
		return kept.filter((path) => ['/timeline', '/wizard'].includes(path));
	});
	expect(pagesKept).toEqual([]);

	await context.setOffline(true);
	const pages: [string, string][] = [
		['/documents', 'Documents'],
		['/about', 'About']
	];
	for (const [path, heading] of pages) {
		const response = await page.goto(path);
		expect(response?.fromServiceWorker()).toBe(true);
		await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
	}
});

test('a page never opened while the worker was in charge opens offline, with its security policy', async ({
	page,
	context
}) => {
	await page.goto('/');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise<void>((resolve) =>
				navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
					once: true
				})
			);
	});
	// The first load came before the worker, so install is the only way the site root is in the page cache.
	const shell = await page.evaluate(async () => {
		for (const name of await caches.keys()) {
			if (!name.startsWith('app-')) continue;
			const kept = await (await caches.open(name)).match('/');
			if (kept) return kept.text();
		}
		return null;
	});
	expect(shell).not.toBeNull();
	// The budget weighs the kept page by this allowance, since it is a served page and not a built file.
	expect(gzipSync(shell ?? '', { level: 9 }).length).toBeLessThanOrEqual(SHELL_BYTES_ALLOWANCE);

	await context.setOffline(true);
	const pages: [string, string | RegExp][] = [
		['/documents', 'Documents'],
		['/about', 'About'],
		['/', /military transition/i]
	];
	for (const [path, heading] of pages) {
		const response = await page.goto(path);
		expect(response?.fromServiceWorker()).toBe(true);
		expect(response?.headers()['content-security-policy'] ?? '').toContain("default-src 'self'");
		await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
	}
});
