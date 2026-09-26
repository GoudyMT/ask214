import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import SettingsPage from './+page.svelte';
import { ASK_ASSET_CACHE } from '$lib/ask/asset-cache';
import { LOCAL_DOCUMENTS } from '$lib/sources/local-documents.data';

// The page reads the app's state from the layout's context. Here the app is ready, with no profile yet, and
// installed, so the page draws the sections every user sees - the Documents row among them.
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store: null,
		timeline: null,
		calendar: null,
		byok: null,
		cause: null,
		wipeAll: null,
		relockAll: null
	}),
	setProfileApp: () => {}
}));
vi.mock('$lib/install/context', () => ({
	getInstallApp: () => ({
		canPrompt: false,
		installed: true,
		ios: false,
		persisted: true,
		promptInstall: async () => 'dismissed'
	}),
	setInstallApp: () => {}
}));

const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const SERVED = Object.keys(LOCAL_DOCUMENTS).length;

beforeEach(async () => {
	await caches.delete(ASK_ASSET_CACHE);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// Integration: the Documents row reads the real Cache API, as the Documents page does.
describe('Settings, the Documents row', () => {
	// The device will not give the older copy's size, so it is counted without one rather than as 0.0 MB.
	it('counts an older copy whose size cannot be read without a size', async () => {
		const old = '/docs/tap_vet_centers.0badc0de.pdf';
		const cache = await caches.open(ASK_ASSET_CACHE);
		await cache.put(old, new Response(new Uint8Array(250_000)));
		const realMatch = Cache.prototype.match;
		vi.spyOn(Cache.prototype, 'match').mockImplementation(function (
			this: Cache,
			request: RequestInfo | URL,
			options?: CacheQueryOptions
		) {
			if (String(request) === old) return Promise.reject(new DOMException('E_TEST_READ'));
			return realMatch.call(this, request, options);
		});
		const { container } = render(SettingsPage);
		const summary = () => text(container.querySelector('.documents-summary span') as Element);

		await vi.waitFor(() =>
			expect(summary()).toBe(`0 of ${SERVED} saved on this device - 0.0 MB, plus 1 older copy`)
		);
	});
});
