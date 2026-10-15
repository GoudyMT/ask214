import { describe, it, expect, vi } from 'vitest';
import { ASK_ASSET_CACHE } from '$lib/ask/asset-cache';
import { eraseCaches } from './erase-caches';

// Cache Storage in memory: cache name -> pathname -> body.
function namedCaches(initial: Record<string, Record<string, string>>) {
	const store = new Map(
		Object.entries(initial).map(([name, entries]) => [name, new Map(Object.entries(entries))])
	);
	const pathOf = (request: Request | string) =>
		new URL(typeof request === 'string' ? request : request.url, 'https://ask214.com').pathname;
	const api = {
		async keys() {
			return [...store.keys()];
		},
		async open(name: string) {
			const entries = store.get(name) ?? new Map<string, string>();
			store.set(name, entries);
			return {
				async keys() {
					return [...entries.keys()].map((path) => new Request(`https://ask214.com${path}`));
				},
				async delete(request: Request | string) {
					return entries.delete(pathOf(request));
				}
			};
		},
		async delete(name: string) {
			return store.delete(name);
		}
	} as unknown as CacheStorage;
	return { api, held: (name: string) => Object.fromEntries(store.get(name) ?? []) };
}

// Erase removes what the user's use left on the device, and keeps the app's own code so the app still opens
// offline afterwards: those files are the same for every user and nothing reinstalls them until the next update.
describe('eraseCaches (what an erase leaves in Cache Storage)', () => {
	const WORKER = '/_app/immutable/workers/embed.worker-Ab12_cd.js';

	it('deletes every cache but the app code caches', async () => {
		const { api } = namedCaches({
			'app-2': { '/': 'shell' },
			'app-1': { '/': 'old shell' },
			[ASK_ASSET_CACHE]: { '/docs/tap_vet_centers.1dcfd966.pdf': 'doc' },
			'ask-assets-v0': { '/models/x.onnx': 'model' },
			'transformers-cache': { '/x': 'other' }
		});
		await eraseCaches(api);
		expect(await api.keys()).toEqual(['app-2', 'app-1']);
	});

	it('keeps the app page and the build files, and drops the pages opened and the embed worker script', async () => {
		const { api, held } = namedCaches({
			'app-2': {
				'/': 'shell',
				'/_app/immutable/entry/start.Bc1.js': 'code',
				'/_app/immutable/assets/app.Df2.css': 'style',
				'/favicon.png': 'icon',
				'/timeline': 'page',
				'/ask': 'page',
				[WORKER]: 'worker'
			}
		});
		await eraseCaches(api);
		expect(held('app-2')).toEqual({
			'/': 'shell',
			'/_app/immutable/entry/start.Bc1.js': 'code',
			'/_app/immutable/assets/app.Df2.css': 'style',
			'/favicon.png': 'icon'
		});
	});

	it('lets a failed delete fail the erase rather than report it done', async () => {
		const { api } = namedCaches({ [ASK_ASSET_CACHE]: { '/docs/a.1.pdf': 'doc' } });
		api.delete = vi.fn(async () => {
			throw new Error('E_DELETE');
		});
		await expect(eraseCaches(api)).rejects.toThrow('E_DELETE');
	});

	it('lets a failed delete of a page kept in the app code cache fail the erase too', async () => {
		const { api } = namedCaches({ 'app-2': { '/': 'shell', '/timeline': 'page' } });
		const open = api.open.bind(api);
		api.open = vi.fn(async (name: string) => {
			const cache = await open(name);
			cache.delete = vi.fn(async () => {
				throw new Error('E_ENTRY_DELETE');
			});
			return cache;
		});
		await expect(eraseCaches(api)).rejects.toThrow('E_ENTRY_DELETE');
	});
});
