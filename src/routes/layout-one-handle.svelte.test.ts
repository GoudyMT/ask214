import { createRawSnippet, mount, unmount, type Component } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { DB_VERSION } from '$lib/db/schema';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import Layout from './+layout.svelte';
import SettingsPage from './settings/+page.svelte';
import WizardPage from './wizard/+page.svelte';

// The real layout starts up on a test database and a real page is shown inside it, the way a tab lives. Only what a
// test must read is intercepted: the layout's open of the default database goes to the test database, and every
// connection it hands back is counted, so a page that opened one of its own would be seen.
const harness = vi.hoisted(() => ({
	name: '',
	opened: [] as Promise<IDBDatabase>[],
	app: null as ProfileApp | null,
	Page: null as unknown,
	mounted: null as object | null
}));

vi.mock('$lib/db/schema', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/db/schema')>();
	return {
		...real,
		openMtcDb: (...args: Parameters<typeof real.openMtcDb>) => {
			if (args[0] !== undefined) return real.openMtcDb(...args);
			const opened = real.openMtcDb(harness.name, args[1], args[2]);
			harness.opened.push(opened);
			return opened;
		}
	};
});
vi.mock('$lib/profile/context', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/profile/context')>();
	return {
		...real,
		// The shown page sits outside the layout's component tree, so it reads the app the layout set.
		getProfileApp: () => harness.app,
		setProfileApp: (app: ProfileApp) => {
			harness.app = app;
			real.setProfileApp(app);
		}
	};
});
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
// No service worker controls the test page, and the wait for one is ten seconds.
vi.mock('$lib/ask/when-controlled', () => ({ waitForControl: () => Promise.resolve(true) }));

// The page under test is mounted by the layout's own children, so it lives and goes with the layout.
const children = createRawSnippet(() => ({
	render: () => '<div></div>',
	setup: (host: Element) => {
		harness.mounted = mount(harness.Page as Component, { target: host });
		return () => leavePage();
	}
}));

function leavePage(): void {
	if (harness.mounted === null) return;
	const gone = harness.mounted;
	harness.mounted = null;
	void unmount(gone);
}

let db: IDBDatabase | null = null;

async function device(withProfile: boolean): Promise<void> {
	db = await openTestDb();
	harness.name = db.name;
	await bootstrapLocalKeystore(db);
	if (withProfile) {
		await createProfileStore(db).save({
			eaos: new TextEncoder().encode('2027-04-15'),
			setupIntent: 'completed'
		});
	}
}

async function appIsReady(): Promise<ProfileApp> {
	await vi.waitFor(() => {
		expect(harness.app?.status).toBe('ready');
		expect(harness.app?.publish).not.toBeNull();
	});
	if (harness.app === null) throw new Error('test setup: the layout set no app');
	return harness.app;
}

const PAGES = [
	{
		name: 'Settings',
		Page: SettingsPage,
		profile: true,
		// What shows that the page has put the Backup card up, which is what it needs a database for.
		cardUp: () => page.getByRole('heading', { level: 2, name: 'Backup', exact: true })
	},
	{
		name: 'wizard',
		Page: WizardPage,
		profile: false,
		cardUp: () =>
			page.getByRole('button', {
				name: 'Moving to a new phone? Restore from a backup',
				exact: true
			})
	}
] as const;

beforeEach(() => {
	harness.app = null;
	harness.opened = [];
	harness.mounted = null;
	// The test page has no service worker file to register.
	vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue({} as ServiceWorkerRegistration);
});

afterEach(async () => {
	leavePage();
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
});

describe.each(PAGES)('a $name visit under the real layout', ({ Page, profile, cardUp }) => {
	beforeEach(() => {
		harness.Page = Page;
	});

	// A second connection is one more thing another tab's upgrade waits on, and a page that closed its own could not
	// have closed the layout's. With one handle, going to a page and leaving it leaves the app's connection as it was.
	it('opens no second connection, and leaving it leaves the app connection open', async () => {
		await device(profile);
		const indexedDbOpen = vi.spyOn(indexedDB, 'open');
		await render(Layout, { children });
		const app = await appIsReady();
		await expect.element(cardUp()).toBeVisible();

		expect(harness.opened).toHaveLength(1);
		// The support check opens a throwaway database of its own; the app's database is opened by the layout alone.
		expect(indexedDbOpen.mock.calls.filter(([name]) => name === harness.name)).toHaveLength(1);
		expect(app.db).toBe(await harness.opened[0]);

		leavePage();
		expect(() => app.db?.transaction('keystore', 'readonly')).not.toThrow();
		expect(app.db).not.toBeNull();
	});

	// The layout's own version-change handler is the only one: a tab on a newer bundle upgrades the database at once
	// (no `blocked`), and this tab is told to reload.
	it('does not hold up an upgrade from another tab', async () => {
		await device(profile);
		await render(Layout, { children });
		const app = await appIsReady();
		await expect.element(cardUp()).toBeVisible();

		// A request that is held up reports `blocked` and then waits for the holder: the wait ends here, so it reads as a
		// failed assertion and not as a timeout.
		let blocked = false;
		const upgraded = await new Promise<IDBDatabase | null>((resolve, reject) => {
			const request = indexedDB.open(harness.name, DB_VERSION + 1);
			request.onblocked = () => {
				blocked = true;
				resolve(null);
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		upgraded?.close();

		expect(blocked).toBe(false);
		await vi.waitFor(() => expect(app.status).toBe('stale'));
	});
});
