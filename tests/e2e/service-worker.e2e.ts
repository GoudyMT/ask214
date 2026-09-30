import { expect, test, type Page } from '@playwright/test';

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
	// Stand-ins for the multi-megabyte artifacts: a corpus filename no build has ever shipped, so it cannot
	// be in the asset list - exactly the position a retired generation is in - and a /models/ entry that is
	// likewise absent from the list, which the prune must still keep because it is outside /corpus/.
	const STALE_CORPUS = '/corpus/corpus-v0.0.0-superseded.json';
	const MODEL_PROBE = '/models/e2e-prune-probe.onnx';

	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.evaluate(
		async ({ cacheName, stale, model }) => {
			const cache = await caches.open(cacheName);
			await cache.put(stale, new Response('stale corpus'));
			await cache.put(model, new Response('model bytes'));
		},
		{ cacheName: ASSET_CACHE, stale: STALE_CORPUS, model: MODEL_PROBE }
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
	const MODEL_PROBE = '/models/e2e-worker-probe.onnx';
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
		const { workerScripts, requested } = await installAgain(page, [MODEL_PROBE]);
		expect(workerScripts).toHaveLength(1);
		expect(requested.filter((path) => WORKER_SCRIPT.test(path))).toEqual([]);
	});

	test('a device that did not set up gets no worker script', async ({ page }) => {
		const { workerScripts, shell } = await installAgain(page, []);
		// Guard against a vacuous pass: the release cache exists and holds the page kept at install.
		expect(shell).toEqual(['/']);
		expect(workerScripts).toEqual([]);
	});
});
