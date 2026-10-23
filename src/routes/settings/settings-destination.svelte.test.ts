import { render } from 'vitest-browser-svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import SettingsPage from './+page.svelte';

// The page runs on the real profile store over a test database, so "the profile holds it" is read back from the store.
const harness = vi.hoisted(() => ({ app: null as ProfileApp | null }));
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => harness.app,
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

const REFUSED = 'Enter a 5-digit ZIP code or a state name.';
const LABEL = 'Where you plan to live';
const HINT =
	'A ZIP code or state. The SkillBridge finder can start from it. It stays on this device.';

let db: IDBDatabase | null = null;

/** A device whose profile has a separation date, which is what shows the Transition timeline section. */
async function device(place?: string) {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	const store = createProfileStore(db);
	await store.save({
		eaos: new TextEncoder().encode('2099-01-01'),
		setupIntent: 'completed',
		...(place ? { geographicDestination: new TextEncoder().encode(place) } : {})
	});
	harness.app = {
		status: 'ready',
		store,
		timeline: null,
		calendar: null,
		finder: null,
		finderPack: null,
		finderFailed: false,
		byok: null,
		cause: null,
		db,
		wipeAll: null,
		relockAll: null,
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
	};
	return store;
}

afterEach(async () => {
	harness.app = null;
	if (db) await deleteTestDb(db);
	db = null;
});

const section = () => page.getByRole('region', { name: 'Transition timeline' });
const row = () => section().getByRole('button', { name: LABEL });

async function enter(text: string): Promise<void> {
	await row().click();
	await page.getByLabelText(LABEL).fill(text);
	await section()
		.getByRole('button', { name: /^save$/i })
		.click();
}

describe('Settings, where you plan to live', () => {
	it('reads Not set with no place, and says what the place is for', async () => {
		await device();
		await render(SettingsPage);
		await expect.element(row()).toMatchTextContent('Not set');
		await row().click();
		await expect.element(page.getByText(HINT)).toBeVisible();
	});

	it('saves a ZIP code into the encrypted profile and shows it', async () => {
		const store = await device();
		await render(SettingsPage);
		await enter('21046');

		await expect.element(row()).toMatchTextContent('21046');
		expect(store.geographicDestination).toBe('21046');
		// Held on disk, not just in memory: a relock and a re-read finds it.
		store.relockSync('user');
		await store.load();
		expect(store.geographicDestination).toBe('21046');
	});

	it.each([
		['Maryland', 'Maryland'],
		['maryland', 'Maryland'],
		['md', 'Maryland']
	])('saves a state typed as %s as %s', async (typed, saved) => {
		const store = await device();
		await render(SettingsPage);
		await enter(typed);

		await expect.element(row()).toMatchTextContent(saved);
		expect(store.geographicDestination).toBe(saved);
	});

	it.each(['12', 'Marylnd', '  '])(
		'refuses %j with the finder line and saves nothing',
		async (typed) => {
			const store = await device();
			// A write still in flight would not show in the store yet: the refusal must not start one at all.
			const save = vi.spyOn(store, 'save');
			await render(SettingsPage);
			await enter(typed);

			await expect.element(page.getByText(REFUSED)).toBeVisible();
			expect(save).not.toHaveBeenCalled();
			expect(store.geographicDestination).toBeNull();
			expect(store._getStateForTest()?.generation).toBe(1);
		}
	);

	it('removes a saved place', async () => {
		const store = await device('Maryland');
		await render(SettingsPage);
		await expect.element(row()).toMatchTextContent('Maryland');
		await row().click();
		await section()
			.getByRole('button', { name: /^remove$/i })
			.click();

		await expect.element(row()).toMatchTextContent('Not set');
		expect(store.geographicDestination).toBeNull();
	});

	it('says so, and keeps the form, when the save fails', async () => {
		const store = await device();
		vi.spyOn(store, 'save').mockRejectedValue(new Error('E_TEST_WRITE'));
		await render(SettingsPage);
		await enter('21046');

		await expect
			.element(page.getByText('Could not update right now - please try again.'))
			.toBeVisible();
		expect(store.geographicDestination).toBeNull();
	});

	it('shows nothing of the place while the profile is locked', async () => {
		const store = await device('Maryland');
		await render(SettingsPage);
		await expect.element(row()).toMatchTextContent('Maryland');
		store.relockSync('user');

		await expect.element(page.getByText('Your data is locked')).toBeVisible();
		expect(page.getByText('Maryland').query()).toBeNull();
		expect(page.getByText(LABEL).query()).toBeNull();
	});
});
