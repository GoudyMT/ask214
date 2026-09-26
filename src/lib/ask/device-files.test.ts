import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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

// A CacheStorage stand-in holding the given paths in the asset cache, or no asset cache at all (null).
function storageHolding(paths: readonly string[] | null) {
	const cache = {
		match: async (request: RequestInfo | URL) =>
			paths?.includes(String(request)) ? new Response('') : undefined
	};
	return {
		has: async (name: string) => paths !== null && name === ASK_ASSET_CACHE,
		open: async () => cache
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
			has: async () => {
				throw new Error('E_TEST_REFUSED');
			}
		} as unknown as CacheStorage;
		expect(await deviceFilesKept(refusing)).toBe(false);
	});
});
