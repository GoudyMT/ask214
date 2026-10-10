import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import SettingsPage from './+page.svelte';
import { ASK_ASSET_CACHE } from '$lib/ask/asset-cache';
import { LOCAL_DOCUMENTS } from '$lib/sources/local-documents.data';
import { OccConflictError } from '$lib/profile/store.svelte';
import { page } from 'vitest/browser';

// The page reads the app's state from the layout's context. Here the app is ready, with no profile yet, and
// installed, so the page draws the sections every user sees - the Documents row among them.
const { app, store } = vi.hoisted(() => ({
	app: {
		status: 'ready',
		store: null as object | null,
		timeline: null as object | null,
		calendar: null as object | null,
		byok: null as object | null,
		cause: null,
		wipeAll: null,
		relockAll: null
	},
	store: {
		locked: false,
		clockBackward: false,
		persona: {
			completeness: 'eaos-only',
			eaos: '2031-06-30',
			daysUntilSeparation: 1700,
			leaving: undefined
		},
		save: vi.fn(),
		refresh: vi.fn()
	}
}));

vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => app,
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
	app.store = null;
	app.timeline = null;
	app.calendar = null;
	app.byok = null;
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
		const { container } = await render(SettingsPage);
		const summary = () => text(container.querySelector('.documents-summary span') as Element);

		await vi.waitFor(() =>
			expect(summary()).toBe(`0 of ${SERVED} saved on this device - 0.0 MB, plus 1 older copy`)
		);
	});
});

describe('Settings, the API key', () => {
	const byok = (saveApiKey: () => Promise<void>, clearApiKey: () => Promise<void>) => ({
		readApiKey: async () => null,
		saveApiKey,
		clearApiKey
	});
	const typeKey = async () => {
		await page.getByLabelText('Your Anthropic API key').fill('sk-ant-secret');
		await page.getByRole('button', { name: /^save$/i }).click();
	};

	it('says so when the key cannot be stored, and shows no stored key', async () => {
		app.byok = byok(
			() => Promise.reject(new Error('E_TEST_WRITE')),
			async () => {}
		);
		await render(SettingsPage);
		await typeKey();

		await expect
			.element(page.getByText('Could not save your key - please enter it again.'))
			.toBeVisible();
		await expect
			.element(page.getByLabelText('Your Anthropic API key'))
			.toHaveAttribute('placeholder', 'sk-ant-...');
	});

	it('shows a stored key once it is stored', async () => {
		app.byok = byok(
			async () => {},
			async () => {}
		);
		await render(SettingsPage);
		await typeKey();

		await expect
			.element(page.getByLabelText('Your Anthropic API key'))
			.toHaveAttribute('placeholder', 'A key is stored');
	});

	it('says so when the key cannot be removed, and still shows it stored', async () => {
		app.byok = byok(
			async () => {},
			() => Promise.reject(new Error('E_TEST_WRITE'))
		);
		await render(SettingsPage);
		await typeKey();
		await page.getByRole('button', { name: 'Remove' }).click();

		await expect
			.element(page.getByText('Could not update right now - please try again.'))
			.toBeVisible();
		await expect
			.element(page.getByLabelText('Your Anthropic API key'))
			.toHaveAttribute('placeholder', 'A key is stored');
	});
});

describe('Settings, a date saved while another tab changed the profile', () => {
	// The text the page shows after a lost race; the page keeps it in OCC_MESSAGE.
	const OCC = 'This was changed in another tab. We reloaded it - please review and save again.';

	it('re-reads the profile and asks the user to review and save again', async () => {
		store.save.mockReset().mockRejectedValue(new OccConflictError());
		store.refresh.mockReset().mockResolvedValue(undefined);
		app.store = store;
		app.timeline = {
			ready: true,
			failed: false,
			locked: false,
			state: { schemaVersion: 1, tasks: {} }
		};
		app.calendar = { ready: true, exclusions: { taskIds: [], categories: [] }, lastAdd: [] };
		const typed = new Date();
		typed.setDate(typed.getDate() + 300);
		const iso = [typed.getFullYear(), typed.getMonth() + 1, typed.getDate()]
			.map((n) => String(n).padStart(2, '0'))
			.join('-');

		await render(SettingsPage);
		const section = page.getByRole('region', { name: 'Transition timeline' });
		await section.getByRole('button', { name: 'Separation date (EAOS)' }).click();
		await page.getByLabelText('Separation date (EAOS)').fill(iso);
		await section.getByRole('button', { name: /^save$/i }).click();

		await expect.element(page.getByText(OCC)).toBeVisible();
		expect(store.save).toHaveBeenCalledTimes(1);
		expect(store.refresh).toHaveBeenCalledTimes(1);
	});
});
