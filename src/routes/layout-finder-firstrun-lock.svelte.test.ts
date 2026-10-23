import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProfileApp } from '$lib/profile/context';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { createFinderStore } from '$lib/skillbridge-finder/state/store.svelte';
import Layout from './+layout.svelte';

// A file of its own: the finder's code is held back on its first load, and a module loads once per file.
const harness = vi.hoisted(() => {
	let open: () => void = () => {};
	return {
		name: '',
		app: null as ProfileApp | null,
		gate: new Promise<void>((resolve) => (open = resolve)),
		release: () => open()
	};
});

vi.mock('$lib/skillbridge-finder/state/pack-store.svelte', async (importOriginal) => {
	await harness.gate;
	return importOriginal();
});
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

// A person can use the finder before finishing setup, so a tab with no profile yet still holds a finder record. A Lock
// there must hold for the finder too, though the profile has nothing in memory to say it is locked.
it('keeps a first-run tab locked when its Lock lands before the finder code arrives', async () => {
	vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue({} as ServiceWorkerRegistration);
	db = await openTestDb();
	harness.name = db.name;
	await bootstrapLocalKeystore(db);
	const seed = createFinderStore(db);
	await seed.load();
	await seed.setSetup({ place: { kind: 'state', state: 'TX' } });

	await render(Layout, { children });
	await vi.waitFor(() => expect(harness.app?.status).toBe('ready'));
	const app = harness.app as ProfileApp;
	expect(app.finder).toBeNull();

	app.relockAll?.();
	harness.release();

	await vi.waitFor(() => expect(app.finder).not.toBeNull());
	// Long enough for a load the wiring wrongly started to land.
	await new Promise((r) => setTimeout(r, 300));
	expect(app.finder?.setup.place).toBeUndefined();
	expect(app.finder?.locked).toBe(true);
	expect(app.finderPack?.locked).toBe(true);
});
