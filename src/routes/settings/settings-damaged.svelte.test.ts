import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';

// The erase refuses here, as one that cannot reach every store does: a real erase ends in a page reload, which this
// page test cannot survive. The end-to-end test erases for real.
const { wipeAll } = vi.hoisted(() => ({
	wipeAll: vi.fn(async () => {
		throw new Error('E_TEST_WIPE');
	})
}));

// The data saved on this device failed its checks at start-up: no profile, no stores, only the erase.
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'damaged',
		store: null,
		timeline: null,
		calendar: null,
		byok: null,
		cause: null,
		wipeAll,
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

describe('Settings, when the saved data cannot be read', () => {
	it('offers only the erase, with what it does', async () => {
		render(SettingsPage);
		await expect
			.element(page.getByRole('heading', { level: 2, name: 'Privacy and security' }))
			.toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Erase all data on this device' }))
			.toBeVisible();
		await expect
			.element(
				page.getByText(
					'Erasing removes everything saved on this device, so the app can start again.'
				)
			)
			.toBeVisible();
		expect(page.getByRole('button', { name: /^lock$/i }).elements()).toHaveLength(0);
		expect(page.getByRole('heading', { level: 2 }).elements()).toHaveLength(1);
	});

	it('erases through the same dialog, and says so when the erase refuses', async () => {
		render(SettingsPage);
		await page.getByRole('button', { name: 'Erase all data on this device' }).click();
		await expect
			.element(page.getByRole('heading', { name: 'Erase all data on this device?' }))
			.toBeVisible();
		await page.getByRole('button', { name: 'Erase everything' }).click();
		expect(wipeAll).toHaveBeenCalledOnce();
		await expect
			.element(page.getByText('Could not erase your data. Nothing was deleted - please try again.'))
			.toBeVisible();
	});
});
