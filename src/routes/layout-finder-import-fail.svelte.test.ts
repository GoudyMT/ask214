import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import Layout from './+layout.svelte';

// A file of its own: the finder's code is replaced for the whole file.
const harness = vi.hoisted(() => ({ name: '', app: null as ProfileApp | null }));

// The finder's code fails on its way in. A module the runner cannot load at all fails the run, not the import, so the
// failure is raised where the layout first uses the code.
vi.mock('$lib/skillbridge-finder/state/store.svelte', () => ({
	createFinderStore: () => {
		throw new Error('E_TEST_CHUNK');
	}
}));
vi.mock('$lib/db/schema', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/db/schema')>();
	return {
		...real,
		openMtcDb: (...args: Parameters<typeof real.openMtcDb>) =>
			real.openMtcDb(args[0] ?? harness.name, args[1], args[2])
	};
});
vi.mock('$lib/profile/context', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/profile/context')>();
	return {
		...real,
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

const children = createRawSnippet(() => ({ render: () => '<div></div>' }));
let db: IDBDatabase | null = null;

afterEach(async () => {
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
});

// No store arrives, so without a flag the finder could not tell "still on its way" from "never coming" and would wait
// for ever.
it('says the finder failed when its code cannot be loaded, and keeps the rest of the app', async () => {
	vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue({} as ServiceWorkerRegistration);
	db = await openTestDb();
	harness.name = db.name;
	await bootstrapLocalKeystore(db);
	await createProfileStore(db).save({
		eaos: new TextEncoder().encode('2027-04-15'),
		setupIntent: 'completed'
	});

	await render(Layout, { children });

	await vi.waitFor(() => {
		expect(harness.app?.status).toBe('ready');
		expect(harness.app?.finderFailed).toBe(true);
	});
	expect(harness.app?.finder).toBeNull();
	expect(harness.app?.store?.locked).toBe(false);
});
