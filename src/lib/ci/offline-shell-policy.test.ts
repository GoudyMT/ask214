import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page the service worker falls back to offline (APP_SHELL in src/lib/ask/asset-cache.ts) loads its code by
// relative paths (`./_app/...`), which resolve correctly only from a top-level address. A nested page route would
// open offline as a blank page, so adding one must change the fallback first.
const ROUTES_DIR = fileURLToPath(new URL('../../routes', import.meta.url));

// A page route is any folder with a page file - a component, or only a load (a redirect) - since the shell draws it,
// including a page that resets its layout (`+page@.svelte`). A route group's folder (`(name)`) is not part of the
// address, and a rest parameter (`[...name]`) answers addresses of any depth, so it counts as nested.
const pages = [
	...new Set(
		readdirSync(ROUTES_DIR, { recursive: true, withFileTypes: true })
			.filter(
				(entry) => entry.isFile() && /^\+page(@[^.]*)?(\.server)?\.(svelte|ts|js)$/.test(entry.name)
			)
			.map((entry) => relative(ROUTES_DIR, entry.parentPath))
	)
].map((folder) =>
	folder.split(sep).filter((segment) => segment !== '' && !/^\(.+\)$/.test(segment))
);

describe('every page route is top-level, so the offline fallback page can draw it', () => {
	it('finds the page routes', () => {
		expect(pages.length).toBeGreaterThanOrEqual(8);
	});
	for (const segments of pages) {
		it(`/${segments.join('/')} is at most one level deep`, () => {
			const depth =
				segments.length + (segments.some((segment) => segment.startsWith('[...')) ? 1 : 0);
			expect(depth).toBeLessThanOrEqual(1);
		});
	}
});

// The precache budget counts the pages kept at install from INSTALL_PAGES (content-ops/check-chunk-budget.mjs), so
// the worker must install exactly that list beside the build files - a page added to install alone would go
// uncounted.
describe('the worker installs the pages the budget counts', () => {
	it('installs INSTALL_PAGES with the precache, and nothing else', () => {
		const worker = readFileSync(join(process.cwd(), 'src/service-worker.ts'), 'utf8');
		expect(worker).toMatch(/cache\.addAll\(\[\.\.\.PRECACHE, \.\.\.INSTALL_PAGES\]\)/);
		// The one precache call at install (the library restore and the worker script store with put): no second
		// add, even a commented-out one, beside it.
		expect(worker.match(/\.add(All)?\(/g)).toHaveLength(1);
	});
});

// What install and activate do is ordered, and the libraries' safety rests on the order: the prune runs before the
// worker takes charge, so the download that follows has room; the downloads are not awaited inside activation, which
// would stall every page load after an update; and no prune follows them, because one there would run with this
// release's asset list after a newer release may already be installed. The prune itself deletes on the version rule
// alone: a condition that holds an old answer library back would fill a nearly full device for good.
describe('the worker does its install and activate work in order', () => {
	/**
	 * The source without its comments, so a word in a comment is never read as a call. A `//` right after a colon or
	 * a quote is part of a string (an address), not a comment.
	 */
	const withoutComments = (source: string) =>
		source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
	const worker = withoutComments(
		readFileSync(join(process.cwd(), 'src/service-worker.ts'), 'utf8')
	);
	const assetCache = withoutComments(
		readFileSync(join(process.cwd(), 'src/lib/ask/asset-cache.ts'), 'utf8')
	);

	/** The `sw.addEventListener(name, ...)` call, up to the `});` that closes it at the start of a line. */
	const handler = (name: string) => {
		const start = worker.indexOf(`sw.addEventListener('${name}'`);
		expect(start, name).toBeGreaterThanOrEqual(0);
		return worker.slice(start, worker.indexOf('\n});', start));
	};
	/** A top-level function's text, up to the `}` that closes it at the start of a line. */
	const functionIn = (source: string, signature: string) => {
		const start = source.indexOf(signature);
		expect(start, signature).toBeGreaterThanOrEqual(0);
		return source.slice(start, source.indexOf('\n}', start));
	};
	/** Where `name(` is called in the worker: not where it is defined, and not a longer name ending in it. */
	const callsOf = (name: string) => [
		...worker.matchAll(new RegExp(`(?<![\\w.]|function )${name}\\(`, 'g'))
	];
	/** The first statement that does not appear after the one before it, or undefined when all do in order. */
	const firstOutOfOrder = (source: string, statements: RegExp[]) => {
		let from = 0;
		for (const statement of statements) {
			const at = source.slice(from).search(statement);
			if (at < 0) return String(statement);
			from += at + 1;
		}
		return undefined;
	};

	it('awaits the restore then the script keep at install, and the prune then the claim at activate, starting both retries unawaited and chaining nothing after them', () => {
		expect(
			firstOutOfOrder(handler('install'), [
				/\n\s*await restoreKeptLibraries\(cacheNames\);/,
				/\n\s*await keepEmbedWorkerScript\(cacheNames\);/
			]),
			'install statement missing or out of order'
		).toBeUndefined();

		const activate = handler('activate');
		expect(
			firstOutOfOrder(activate, [
				/\n\s*await pruneSupersededVersions\(keys\);/,
				/\n\s*await sw\.clients\.claim\(\);/,
				/\n\s*void restoreKeptLibraries\(keys\);/,
				/\n\s*void keepEmbedWorkerScript\(keys\);/
			]),
			'activate statement missing or out of order'
		).toBeUndefined();
		expect(activate, 'a retry is awaited').not.toMatch(
			/await (restoreKeptLibraries|keepEmbedWorkerScript)/
		);
		expect(activate, 'something is chained after the library retry').not.toMatch(
			/restoreKeptLibraries\(keys\)\s*\./
		);
	});

	// Counted over the whole file, not one handler: a second prune or a second restore placed anywhere - a helper
	// that activate calls, a callback chained to a retry - changes what runs when, and a pin that reads only the
	// activate handler would not see it.
	it('calls the prune once, at activate and not at install, and each restore once at install and once, unawaited, after activation', () => {
		expect(callsOf('pruneSupersededVersions'), 'prune calls in the worker').toHaveLength(1);
		expect(
			callsOf('pruneSupersededEntries'),
			'calls of the shared prune in the worker'
		).toHaveLength(1);
		expect(handler('install'), 'the prune runs at install').not.toMatch(/prune\w*\(/i);
		expect(
			handler('activate').match(/pruneSupersededVersions\(/g),
			'the prune at activate'
		).toHaveLength(1);
		// A prune written out by hand, under any name, still deletes with `.delete(`: the one in the worker is the
		// sweep of stale app caches at activate, and the one in the asset-cache module is the shared prune's.
		expect(
			worker.match(/\.delete\(/g),
			'a delete in the worker besides the cache sweep'
		).toHaveLength(1);
		expect(
			handler('activate').match(/await caches\.delete\(key\);/g),
			'the one delete is not the cache sweep at activate'
		).toHaveLength(1);
		expect(
			assetCache.match(/\.delete\(/g),
			'a delete in asset-cache besides the shared prune'
		).toHaveLength(1);

		for (const retry of ['restoreKeptLibraries', 'keepEmbedWorkerScript']) {
			expect(callsOf(retry), `${retry} calls in the worker`).toHaveLength(2);
			expect(
				handler('install').match(new RegExp(`await ${retry}\\(cacheNames\\);`, 'g')),
				retry
			).toHaveLength(1);
			expect(
				handler('activate').match(new RegExp(`void ${retry}\\(keys\\);`, 'g')),
				retry
			).toHaveLength(1);
		}
	});

	// The comment stripper decides what the pins above read, so a stripper that ate code would blind them.
	it('reads the code of the worker and the asset-cache module, comments aside', () => {
		expect(worker).toMatch(/cache\.addAll\(\[\.\.\.PRECACHE, \.\.\.INSTALL_PAGES\]\)/);
		expect(worker).toMatch(/new URL\(event\.request\.url\)/);
		expect(assetCache).toMatch(/export async function pruneSupersededEntries\(/);
		expect(assetCache).toMatch(/https:\/\/chunk\.invalid/);
		expect(withoutComments('a(); // b()\n/* c() */ d(); "http://e"')).toBe(
			'a(); \n d(); "http://e"'
		);
	});

	it('chains no prune after a retry: nothing follows the last retry, and no retry has a callback', () => {
		const activate = handler('activate');
		const afterRetries = activate.slice(
			activate.indexOf('void keepEmbedWorkerScript(keys);') +
				'void keepEmbedWorkerScript(keys);'.length
		);
		expect(afterRetries.replace(/\s|[)}(;]/g, ''), 'something follows the last retry').toBe('');

		const lastRetry = Math.max(...callsOf('restoreKeptLibraries').map((call) => call.index));
		for (const prune of callsOf('pruneSupersededVersions'))
			expect(prune.index, 'a prune is called after a retry').toBeLessThan(lastRetry);

		for (const retry of ['restoreKeptLibraries', 'keepEmbedWorkerScript']) {
			expect(worker, `a callback is chained to ${retry}`).not.toMatch(
				new RegExp(`${retry}\\([^)]*\\)\\s*\\.(then|catch|finally)\\(`)
			);
			expect(functionIn(worker, `async function ${retry}(`), `${retry} runs a prune`).not.toMatch(
				/pruneSuperseded\w*\(/
			);
		}
	});

	// The wrapper only guards the shared prune, which the full-disk test also runs; the prune's one delete hangs on
	// the version rule and nothing else, and it reads every same-origin entry, so no entry is held back by a
	// condition of its own.
	it('guards the shared prune in the worker, and the shared prune deletes on the version rule alone', () => {
		const wrapper = functionIn(worker, 'async function pruneSupersededVersions(');
		expect(wrapper, 'the wrapper skips a device with no asset cache').toMatch(
			/if \(!cacheNames\.includes\(ASK_ASSET_CACHE\)\) return;/
		);
		expect(
			wrapper,
			'the wrapper does not guard the prune, or does not call the shared one'
		).toMatch(
			/try \{\s*await pruneSupersededEntries\(await caches\.open\(ASK_ASSET_CACHE\), sw\.location\.origin, ASSETS\);\s*\} catch \{/
		);
		expect(wrapper.match(/\.delete\(/g), 'the wrapper deletes itself').toBeNull();

		const prune = functionIn(assetCache, 'export async function pruneSupersededEntries(');
		expect(prune.match(/\.delete\(/g), 'the prune deletes in more than one place').toHaveLength(1);
		expect(prune, 'the prune deletes on something besides the version rule').toMatch(
			/of held\) \{\s*if \(isSupersededVersionedEntry\(pathname, shipped\)\) await cache\.delete\(request\);\s*\}/
		);
		expect(prune, 'the prune reads fewer than every same-origin entry').toMatch(
			/if \(url\.origin === origin\) held\.push\(\{ request, pathname: url\.pathname \}\);/
		);
	});
});
