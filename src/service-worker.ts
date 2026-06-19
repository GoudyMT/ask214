/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';
import { classifyAsset, ASK_ASSET_CACHE, shouldKeepCache } from '$lib/ask/asset-cache';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `app-${version}`;
const ASSETS = [...build, ...files];
// Precache the app shell + small static assets at install; the heavy model/wasm (classifyAsset -> 'lazy')
// are EXCLUDED so install stays light + robust, and they cache on first /ask fetch instead (ADR-015).
const PRECACHE = ASSETS.filter((path) => classifyAsset(path) === 'precache');

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHE);
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				// Keep the current app-shell cache + the unversioned lazy asset cache; drop stale app caches.
				if (!shouldKeepCache(key, CACHE)) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;

	const url = new URL(event.request.url);

	// Only handle same-origin requests
	if (url.origin !== sw.location.origin) return;

	event.respondWith(
		(async () => {
			// Lazy model/wasm -> their own unversioned cache (survives app updates, sweep S26 H2);
			// everything else -> the versioned app-shell cache.
			const cache = await caches.open(
				classifyAsset(url.pathname) === 'lazy' ? ASK_ASSET_CACHE : CACHE
			);

			// Cache-first for built assets
			if (ASSETS.includes(url.pathname)) {
				const cached = await cache.match(event.request);
				if (cached) return cached;
			}

			// Network-first for pages, fall back to cache
			try {
				const response = await fetch(event.request);
				if (response.status === 200) {
					cache.put(event.request, response.clone());
				}
				return response;
			} catch {
				const cached = await cache.match(event.request);
				if (cached) return cached;
				return new Response('Offline', { status: 503 });
			}
		})()
	);
});
