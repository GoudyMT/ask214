import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_ASSET_CACHE, CORPUS_BASE } from './asset-cache';
import { DEVICE_FILES, deviceFilesKept } from './device-files';

const MODEL_DIR = '/models/Xenova/all-MiniLM-L6-v2/';
const STATIC = join(process.cwd(), 'static');

describe('DEVICE_FILES', () => {
	it('lists every file the vendored model manifest pins', () => {
		const manifest = JSON.parse(
			readFileSync(join(process.cwd(), 'src/lib/ask/model-vendor.manifest.json'), 'utf8')
		) as Record<string, string>;
		for (const file of Object.keys(manifest)) expect(DEVICE_FILES).toContain(MODEL_DIR + file);
	});

	it('lists the answer library the page loads', () => {
		expect(DEVICE_FILES).toContain(`${CORPUS_BASE}.json`);
		expect(DEVICE_FILES).toContain(`${CORPUS_BASE}.embeddings.bin`);
	});

	it('names only files the app ships', () => {
		for (const path of DEVICE_FILES) expect(existsSync(join(STATIC, path)), path).toBe(true);
	});
});

// A CacheStorage stand-in holding the given paths in the asset cache, or no asset cache at all (null). A lookup
// that does not name the asset cache finds nothing, so a check reading any other cache fails.
function storageHolding(paths: readonly string[] | null) {
	return {
		match: async (request: RequestInfo | URL, options?: MultiCacheQueryOptions) =>
			options?.cacheName === ASK_ASSET_CACHE && paths?.includes(String(request))
				? new Response('')
				: undefined
	} as unknown as CacheStorage;
}

describe('deviceFilesKept', () => {
	it('is true when every file is kept', async () => {
		expect(await deviceFilesKept(storageHolding(DEVICE_FILES))).toBe(true);
	});

	it('is false when any one file is missing', async () => {
		for (const missing of DEVICE_FILES) {
			const held = DEVICE_FILES.filter((path) => path !== missing);
			expect(await deviceFilesKept(storageHolding(held)), missing).toBe(false);
		}
	});

	it('is false when there is no asset cache', async () => {
		expect(await deviceFilesKept(storageHolding(null))).toBe(false);
	});

	it('is false where the browser has no Cache API', async () => {
		expect(await deviceFilesKept(undefined)).toBe(false);
	});

	it('is false, not an error, when the cache cannot be read', async () => {
		const refusing = {
			match: async () => {
				throw new Error('E_TEST_REFUSED');
			}
		} as unknown as CacheStorage;
		expect(await deviceFilesKept(refusing)).toBe(false);
	});

	// The Ask is created only once this answers, crisis routing and online answers included, so a cache that
	// never answers must not hold it up: past the limit the answer is "not kept", which asks before downloading.
	it('is false at the time limit when the cache never answers', async () => {
		vi.useFakeTimers();
		try {
			const silent = { match: () => new Promise(() => {}) } as unknown as CacheStorage;
			let verdict: boolean | undefined;
			void deviceFilesKept(silent, 1_000).then((kept) => (verdict = kept));
			await vi.advanceTimersByTimeAsync(999);
			expect(verdict).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(verdict).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

// The Ask view states the one-time download's size in four places. The figure is the files an on-device answer
// downloads, rounded to the nearest 5 MB, so a new model or answer library cannot leave the words behind.
describe('the download size the Ask view states', () => {
	it('matches the on-device files, to the nearest 5 MB, everywhere it is stated', () => {
		const bytes = DEVICE_FILES.reduce((sum, path) => sum + statSync(join(STATIC, path)).size, 0);
		const view = readFileSync(join(process.cwd(), 'src/lib/components/AskView.svelte'), 'utf8');
		const stated = [...view.matchAll(/(\d+(?:\.\d+)?)\s?MB/g)].map((match) => Number(match[1]));
		expect(stated).toHaveLength(4);
		// Rounded up, so the figure can over-state the download but never under-state it.
		for (const megabytes of stated) expect(megabytes).toBe(Math.ceil(bytes / 5e6) * 5);
	});

	// "Works offline" holds only once the browser keeps the files - a browser that cannot keep them asks again - so
	// wherever the view says it, it says that first. Read across line breaks: the markup wraps the phrase.
	it('says "works offline" only after "once your browser keeps it"', () => {
		const view = readFileSync(join(process.cwd(), 'src/lib/components/AskView.svelte'), 'utf8');
		const claims = [...view.matchAll(/works?\s+offline/g)];
		expect(claims.length).toBeGreaterThan(0);
		for (const claim of claims) {
			const before = view
				.slice(Math.max(0, (claim.index ?? 0) - 100), claim.index)
				.replace(/\s+/g, ' ');
			expect(before, claim[0]).toMatch(/keeps it/i);
		}
	});
});
