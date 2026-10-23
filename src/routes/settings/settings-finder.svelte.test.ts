import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ProfileApp } from '$lib/profile/context';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { device, network, startedSession } from '$lib/skillbridge-finder/ui/list-world';
import SettingsPage from './+page.svelte';

// The Settings page with the finder's stores open: its SkillBridge section is there, and a Lock takes it away with
// the rest of what is personal.
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

// Reactive, as the profile store's lock is: Lock swaps the page's sections at that moment.
const profile = $state({ locked: false });
let db: IDBDatabase | null = null;

beforeEach(() => {
	profile.locked = false;
	const net = network();
	vi.spyOn(globalThis, 'fetch').mockImplementation((input) => net.fetchFn(String(input), {}));
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
});

async function open() {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	const dev = await device(db, {
		place: { kind: 'state', state: 'MD' },
		territories: false,
		overseas: false
	});
	await startedSession(dev, network());
	harness.app = {
		status: 'ready',
		store: {
			get locked() {
				return profile.locked;
			},
			load: async () => {
				profile.locked = false;
			},
			clockBackward: false,
			persona: { completeness: 'none' }
		},
		timeline: null,
		calendar: null,
		finder: dev.finder,
		finderPack: dev.pack,
		finderFailed: false,
		byok: null,
		cause: null,
		wipeAll: null,
		relockAll: () => {
			profile.locked = true;
			dev.finder.relockSync('user');
			dev.pack.relockSync('user');
		},
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
	} as unknown as ProfileApp;
	return dev;
}

describe('Settings, the SkillBridge finder section', () => {
	it('shows the setup and the held week among the page sections', async () => {
		await open();
		await render(SettingsPage);

		await expect.element(page.getByRole('heading', { name: 'SkillBridge finder' })).toBeVisible();
		await expect.element(page.getByText('In Maryland')).toBeVisible();
		await expect.element(page.getByText(/^On - 4\.0 MB, from Oct 21, 2026$/)).toBeVisible();
	});

	it('shows nothing of it once the page is locked', async () => {
		await open();
		await render(SettingsPage);
		await expect.element(page.getByText('In Maryland')).toBeVisible();

		harness.app?.relockAll?.();

		await expect.element(page.getByText('Your data is locked')).toBeVisible();
		expect(page.getByRole('heading', { name: 'SkillBridge finder' }).elements()).toHaveLength(0);
		expect(document.body.textContent).not.toContain('Maryland');
	});
});
