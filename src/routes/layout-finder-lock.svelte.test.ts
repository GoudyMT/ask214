import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import Layout from './+layout.svelte';

// A file of its own: the finder's code is held back on its first load, and a module loads once per file.
const harness = vi.hoisted(() => {
	let open: () => void = () => {};
	return {
		name: '',
		app: null as ProfileApp | null,
		// The pack store's code arrives only when the test lets it through, as on a slow network.
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

// The finder's code loads on demand. A Lock pressed before it arrives must hold once it does: the downloaded listings
// stay unread until an Unlock.
it('leaves the pack locked when a Lock lands before its code arrives', async () => {
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
		expect(harness.app?.store?.locked).toBe(false);
	});
	const app = harness.app as ProfileApp;
	expect(app.finderPack).toBeNull();

	app.relockAll?.();
	harness.release();

	await vi.waitFor(() => expect(app.finderPack).not.toBeNull());
	// Long enough for a load the wiring wrongly started to land.
	await new Promise((r) => setTimeout(r, 300));
	expect(app.finderPack?.locked).toBe(true);
	expect(app.finderPack?.ready).toBe(false);
});
