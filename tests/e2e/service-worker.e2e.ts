import { expect, test, type Page } from '@playwright/test';
import { SET_UP_FILES } from '../../src/lib/ask/asset-cache';

test('service worker registers and activates on home page', async ({ page }) => {
	await page.goto('/');

	// `navigator.serviceWorker.ready` resolves while the active worker may still be
	// in 'activating' state (the activate handler's waitUntil is still running cache
	// cleanup + clients.claim). Wait for the state to reach 'activated' explicitly.
	const state = await page.evaluate(async () => {
		if (!('serviceWorker' in navigator)) return 'unsupported';
		const reg = await navigator.serviceWorker.ready;
		if (!reg.active) return 'no-active-worker';

		return new Promise<string>((resolve) => {
			const check = () => {
				if (reg.active?.state === 'activated') resolve('activated');
			};
			reg.active!.addEventListener('statechange', check);
			// Race check: state may have changed between .ready and listener registration.
			check();
		});
	});

	expect(state).toBe('activated');
});

// The page registers the worker once. A second registration of the same file with another script type counts as an
// update, so each page load would install the worker again - re-adding the precache list - and leave a copy waiting
// behind the one in charge. Counted from inside the page: every register call is recorded, and every install the
// registration announces (updatefound) is counted once the calls have settled.
test('a first visit and two page loads leave no waiting service worker', async ({ page }) => {
	await page.addInitScript(() => {
		const w = window as unknown as { __sw: { calls: Promise<unknown>[]; installs: number } };
		w.__sw = { calls: [], installs: 0 };
		const container = navigator.serviceWorker;
		const register = container.register.bind(container);
		// Every call answers with the same registration object, so it is listened to once.
		const listened = new WeakSet<ServiceWorkerRegistration>();
		container.register = (...args: Parameters<ServiceWorkerContainer['register']>) => {
			const call = register(...args);
			void call.then((registration) => {
				if (listened.has(registration)) return;
				listened.add(registration);
				registration.addEventListener('updatefound', () => w.__sw.installs++);
			});
			w.__sw.calls.push(call);
			return call;
		};
	});

	// The load's registrations, once they have all answered and no worker is still installing; then what the
	// registration holds and how many installs the load started.
	async function settled(): Promise<{ installs: number; waiting: boolean; active: boolean }> {
		await page.waitForFunction(
			() => (window as unknown as { __sw: { calls: unknown[] } }).__sw.calls.length > 0
		);
		return page.evaluate(async () => {
			const w = window as unknown as { __sw: { calls: Promise<unknown>[]; installs: number } };
			await Promise.all(w.__sw.calls);
			const registration = await navigator.serviceWorker.getRegistration();
			// A first install passes through waiting on its way to active, with nothing in charge yet; only a worker
			// waiting behind an active one is left there.
			while (registration?.installing || (registration?.waiting && !registration.active))
				await new Promise((r) => setTimeout(r, 50));
			return {
				installs: w.__sw.installs,
				waiting: registration?.waiting != null,
				active: registration?.active != null
			};
		});
	}

	await page.goto('/');
	expect(await settled(), 'the first visit installs the worker once').toEqual({
		installs: 1,
		waiting: false,
		active: true
	});
	for (const load of [1, 2]) {
		await page.reload();
		expect(await settled(), `load ${load} of the same build installs nothing`).toEqual({
			installs: 0,
			waiting: false,
			active: true
		});
	}
});

// A hard reload (Ctrl+Shift+R) is served without the worker, so the page is not controlled. The setup's wait for a
// worker ends at once when the registration has nothing left pending; a worker left waiting by a second registration
// would make the first download sit out the whole limit (CONTROL_WAIT_MS, 10 s) for nothing. It only waits while
// another tab still uses the worker in charge: with no such tab the waiting worker activates and claims the
// hard-reloaded page, which hides the wait.
//
// Chromium only: Playwright offers no hard reload on WebKit, and the page there cannot be made uncontrolled.
test('a hard-reloaded page starts an Ask setup without waiting out the worker limit', async ({
	page,
	context,
	browserName
}) => {
	test.skip(browserName === 'webkit', 'no hard reload on Playwright WebKit');
	// Nothing in this row downloads the model or asks the answer service: the requests are refused, the start is
	// seen as the embed worker the page creates.
	await context.route(/\/(api|models|wasm|corpus)\//, (route) => route.abort());
	const workers: string[] = [];
	page.on('worker', (worker) => workers.push(worker.url()));

	// A second tab on the app, in the worker's charge, is what keeps a worker installed by the hard-reloaded page
	// waiting: a worker activates at once only when no page is using the one in charge.
	const other = await context.newPage();
	await other.goto('/');
	await other.evaluate(() => navigator.serviceWorker.ready);
	await other.reload();
	expect(await other.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

	const session = await context.newCDPSession(page);
	const loaded = page.waitForEvent('load');
	await session.send('Page.reload', { ignoreCache: true });
	await loaded;
	expect(await page.evaluate(() => navigator.serviceWorker.controller), 'a hard reload').toBeNull();

	const input = page.getByLabel('Ask a question');
	await expect(input).toBeEnabled({ timeout: 30_000 });
	await page.getByRole('button', { name: /^on device$/i }).click();
	await input.fill('what is SkillBridge and how long does it last?');
	await page.getByRole('button', { name: 'Search' }).click();
	await page.getByRole('button', { name: /set up.+answer/i }).click();
	// Well inside the 10 s limit.
	await expect.poll(() => workers.length, { timeout: 5_000 }).toBe(1);
});

// A connection that is up but silent does not fail for minutes, and until it does the app would open blank though the
// worker keeps its page. Past the worker's short wait the kept page is served, and the router draws the address.
//
// Chromium only: Playwright routes a service worker's own requests only there.
test('a page opened on a silent connection opens from the kept page', async ({
	page,
	context,
	browserName
}) => {
	test.skip(browserName === 'webkit', "Playwright routes the worker's requests on Chromium only");
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

	// The page's own address answers nothing, ever: headers never come.
	await context.route('**/documents', () => {});
	await page.goto('/documents', { timeout: 15_000 });
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });
	await context.unrouteAll({ behavior: 'ignoreErrors' });
});

test('built assets are served from the service worker cache after first visit', async ({
	page
}) => {
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);

	const cacheNames = await page.evaluate(async () => (await caches.keys()) ?? []);
	expect(cacheNames.length).toBeGreaterThan(0);
	expect(cacheNames.some((name) => name.startsWith('app-'))).toBe(true);
});

// The lazy asset cache is kept by name on every deploy - that is what preserves the ~45MB model download -
// so the activate-time prune is the only thing that ever retires an entry inside it. The unit tests pin the
// predicate; this pins the wiring, plus the assumption underneath it: that the build's asset list really
// carries the corpus filenames, since that list is what separates a superseded entry from the live one. Were
// the corpus to leave that list, the prune would fail closed and the stale entry below would survive.
//
// Chromium only. The fixture needs a cache that outlives a service-worker re-activation, and unregistering
// then reloading is the only way a test can force a second activate. WebKit ties CacheStorage to the
// presence of a registration and empties it on the next load once none remains - seeding with a registration
// in place survives a plain reload, seeding across an unregister does not - so there the cache is already
// empty before the replacement worker runs, and the fixture cannot exist.
test('activate drops a superseded corpus entry and keeps the heavy model bytes', async ({
	page,
	browserName
}) => {
	test.skip(
		browserName === 'webkit',
		'WebKit empties CacheStorage on the load after the last SW registration is removed'
	);

	// Mirrors ASK_ASSET_CACHE in src/lib/ask/asset-cache.ts.
	const ASSET_CACHE = 'ask-assets-v1';
	// Stand-in for the multi-megabyte answer library: a corpus filename no build has ever shipped, so it cannot
	// be in the asset list - exactly the position a retired generation is in. The device is a set-up one: every
	// model and runtime file the worker counts as a finished setup, which the prune must keep because they are
	// outside /corpus/, and a /models/ entry that is likewise absent from the list.
	const STALE_CORPUS = '/corpus/corpus-v0.0.0-superseded.json';
	const MODEL_PROBE = '/models/e2e-prune-probe.onnx';
	const SET_UP = [...SET_UP_FILES];

	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.evaluate(
		async ({ cacheName, stale, model, setUp }) => {
			const cache = await caches.open(cacheName);
			await cache.put(stale, new Response('stale corpus'));
			await cache.put(model, new Response('model bytes'));
			for (const path of setUp) await cache.put(path, new Response('bytes'));
		},
		{ cacheName: ASSET_CACHE, stale: STALE_CORPUS, model: MODEL_PROBE, setUp: SET_UP }
	);

	// Unregister, then reload for a fresh install + activate over the seeded cache - the position a returning
	// visitor is in when a rebuilt corpus ships under a new filename.
	await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.getRegistration();
		await reg?.unregister();
	});
	await page.reload();

	// A worker reaches 'activated' only once the activate handler's waitUntil has settled, so waiting for
	// that state is also waiting for the prune. Resolve with a string rather than hanging, so a missing
	// worker fails readably instead of timing out.
	const state = await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		if (!reg.active) return 'no-active-worker';
		return new Promise<string>((resolve) => {
			const check = () => {
				if (reg.active?.state === 'activated') resolve('activated');
			};
			reg.active!.addEventListener('statechange', check);
			// Race check: state may have changed between .ready and listener registration.
			check();
		});
	});
	expect(state).toBe('activated');

	const cached = await page.evaluate(
		async (cacheName) =>
			(await (await caches.open(cacheName)).keys()).map((req) => new URL(req.url).pathname),
		ASSET_CACHE
	);
	expect(cached).not.toContain(STALE_CORPUS);
	// Also the guard against a vacuous pass: an emptied cache satisfies the line above but fails this one.
	expect(cached).toContain(MODEL_PROBE);
	for (const path of SET_UP) expect(cached, path).toContain(path);
});

// The embed worker's script is left out of the build list the service worker precaches, and an update deletes the
// previous release's cache, so a device that set up on-device answers would meet its first question after an update
// offline with a worker script nothing had fetched. Install reads the script's name from this release's own code
// and keeps it, for a device that set up - and only for one.
//
// Chromium only, for the reason the test above gives: the fixture is a cache that survives unregistering the
// worker, and WebKit empties CacheStorage on the next load once no registration remains.
test.describe('install keeps the embed worker script for a device that set up on-device answers', () => {
	test.skip(
		({ browserName }) => browserName === 'webkit',
		'WebKit empties CacheStorage on the load after the last SW registration is removed'
	);

	// Mirrors ASK_ASSET_CACHE in src/lib/ask/asset-cache.ts.
	const ASSET_CACHE = 'ask-assets-v1';
	// What a finished setup holds: every model and runtime file. A setup stopped part-way holds only some.
	const SET_UP = [...SET_UP_FILES];
	const WORKER_SCRIPT = /^\/_app\/immutable\/workers\/embed-worker-[^/]+\.js$/;

	/** Seed the asset cache as given, replace the worker by unregistering it and reloading, and return what the release caches hold. */
	async function installAgain(
		page: Page,
		seed: string[]
	): Promise<{ workerScripts: string[]; shell: string[]; requested: string[] }> {
		await page.goto('/');
		await page.evaluate(() => navigator.serviceWorker.ready);
		await page.evaluate(
			async ({ cacheName, paths }) => {
				if (paths.length === 0) return;
				const cache = await caches.open(cacheName);
				for (const path of paths) await cache.put(path, new Response('bytes'));
			},
			{ cacheName: ASSET_CACHE, paths: seed }
		);
		await page.evaluate(async () => {
			const reg = await navigator.serviceWorker.getRegistration();
			await reg?.unregister();
		});

		// What the page itself asks the network for from here on. The service worker's own fetches are not the
		// page's, so a script found in the cache below was kept by install, not requested by the page.
		const requested: string[] = [];
		page.on('request', (request) => requested.push(new URL(request.url()).pathname));
		await page.reload();

		const state = await page.evaluate(async () => {
			const reg = await navigator.serviceWorker.ready;
			if (!reg.active) return 'no-active-worker';
			return new Promise<string>((resolve) => {
				const check = () => {
					if (reg.active?.state === 'activated') resolve('activated');
				};
				reg.active!.addEventListener('statechange', check);
				check();
			});
		});
		expect(state).toBe('activated');

		const held = await page.evaluate(async () => {
			const paths: string[] = [];
			for (const name of await caches.keys()) {
				if (!name.startsWith('app-')) continue;
				for (const request of await (await caches.open(name)).keys())
					paths.push(new URL(request.url).pathname);
			}
			return paths;
		});
		return {
			workerScripts: held.filter((path) => WORKER_SCRIPT.test(path)),
			shell: held.filter((path) => path === '/'),
			requested
		};
	}

	test('a set-up device gets the script at install, without the page asking for it', async ({
		page
	}) => {
		const { workerScripts, requested } = await installAgain(page, SET_UP);
		expect(workerScripts).toHaveLength(1);
		expect(requested.filter((path) => WORKER_SCRIPT.test(path))).toEqual([]);
	});

	test('a setup stopped part-way gets no worker script', async ({ page }) => {
		// The model's small files stored, the model and the runtime not yet.
		const { workerScripts, shell } = await installAgain(page, SET_UP.slice(0, 3));
		expect(shell).toEqual(['/']);
		expect(workerScripts).toEqual([]);
	});

	test('a device that did not set up gets no worker script', async ({ page }) => {
		const { workerScripts, shell } = await installAgain(page, []);
		// Guard against a vacuous pass: the release cache exists and holds the page kept at install.
		expect(shell).toEqual(['/']);
		expect(workerScripts).toEqual([]);
	});
});
