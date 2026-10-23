import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { createProfileBus } from '$lib/broadcast/bus';
import { createFinderStore } from '$lib/skillbridge-finder/state/store.svelte';
import Layout from './+layout.svelte';

// The real layout starts up on a test database, as a tab does, and the finder's two stores are read from the app it
// sets. Only the layout's open of the default database is sent to the test database.
const harness = vi.hoisted(() => ({ name: '', app: null as ProfileApp | null }));

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

async function device(): Promise<IDBDatabase> {
	db = await openTestDb();
	harness.name = db.name;
	await bootstrapLocalKeystore(db);
	await createProfileStore(db).save({
		eaos: new TextEncoder().encode('2027-04-15'),
		setupIntent: 'completed'
	});
	return db;
}

async function finderReady(): Promise<ProfileApp> {
	await vi.waitFor(() => {
		expect(harness.app?.status).toBe('ready');
		expect(harness.app?.finder?.ready).toBe(true);
		expect(harness.app?.finderPack?.ready).toBe(true);
	});
	if (harness.app === null) throw new Error('test setup: the layout set no app');
	return harness.app;
}

beforeEach(() => {
	harness.app = null;
	vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue({} as ServiceWorkerRegistration);
});

afterEach(async () => {
	vi.restoreAllMocks();
	delete (document as unknown as Record<string, unknown>).visibilityState;
	delete (document as unknown as Record<string, unknown>).hidden;
	if (db) await deleteTestDb(db);
	db = null;
});

// A store missing from the relock list keeps the person's saved programs and the downloaded listings decrypted
// through a Lock, an idle timeout and an erase.
it('provisions both finder stores, and a Lock relocks both', async () => {
	await device();
	await render(Layout, { children });
	const app = await finderReady();

	app.relockAll?.();

	expect(app.finder?.ready).toBe(false);
	expect(app.finder?.locked).toBe(true);
	expect(app.finderPack?.ready).toBe(false);
	expect(app.finderPack?.locked).toBe(true);
});

it('shows this tab a finder change saved in another tab', async () => {
	const testDb = await device();
	await render(Layout, { children });
	const app = await finderReady();

	const peer = createFinderStore(testDb);
	await peer.load();
	await peer.setSetup({ place: { kind: 'state', state: 'TX' } });
	const bus = createProfileBus();
	bus.publish({ type: 'skillbridge-finder-updated' });
	bus.close();

	await vi.waitFor(() => expect(app.finder?.setup.place).toEqual({ kind: 'state', state: 'TX' }));
});

// A tab opened in the background drops what it read on the way, as page hygiene; that is not the person's Lock, so the
// finder comes back with the rest of the app when the tab is shown.
it('gives a tab opened in the background its finder back when it is shown', async () => {
	const testDb = await device();
	const seed = createFinderStore(testDb);
	await seed.load();
	await seed.setSetup({ place: { kind: 'state', state: 'TX' } });
	let hidden = true;
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => (hidden ? 'hidden' : 'visible')
	});
	Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

	await render(Layout, { children });
	await vi.waitFor(() => {
		expect(harness.app?.status).toBe('ready');
		expect(harness.app?.finder).not.toBeNull();
		expect(harness.app?.finderPack).not.toBeNull();
	});
	const app = harness.app as ProfileApp;

	hidden = false;
	document.dispatchEvent(new Event('visibilitychange'));

	await vi.waitFor(() => {
		expect(app.finder?.setup.place).toEqual({ kind: 'state', state: 'TX' });
		expect(app.finderPack?.ready).toBe(true);
	});
	expect(app.finder?.locked).toBe(false);
});

// The finder is one tool: a saved record that cannot be read must not take the profile, Timeline or Settings with it.
it('keeps the app working when the saved finder record cannot be read', async () => {
	const testDb = await device();
	// A body with no marker: the store refuses to read it as empty.
	await new Promise<void>((resolve, reject) => {
		const tx = testDb.transaction('skillbridge-finder', 'readwrite');
		tx.objectStore('skillbridge-finder').put({ id: 0, rec: new Uint8Array(8) });
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	await render(Layout, { children });

	await vi.waitFor(() => {
		expect(harness.app?.status).toBe('ready');
		expect(harness.app?.finder?.failed).toBe(true);
	});
	expect(harness.app?.finder?.ready).toBe(false);
	expect(harness.app?.store?.locked).toBe(false);
});
