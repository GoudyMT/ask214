import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_THRESHOLD_MS } from '$lib/profile/idle-threshold';
import type { IdleTimerOptions } from '$lib/profile/idle-timer';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { createProfileBus } from '$lib/broadcast/bus';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import Layout from './+layout.svelte';

// The layout runs the real start-up on a test database; only the database it opens and the two seams a test must read
// (the app container it sets, the idle timer's options) are intercepted.
const harness = vi.hoisted(() => ({
	db: null as Promise<IDBDatabase> | null,
	app: null as ProfileApp | null,
	idle: [] as IdleTimerOptions[]
}));

// The layout opens the default database (no name); the test helpers open a named one, which stays real.
vi.mock('$lib/db/schema', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/db/schema')>();
	return {
		...real,
		openMtcDb: (...args: Parameters<typeof real.openMtcDb>) =>
			args[0] === undefined ? harness.db : real.openMtcDb(...args)
	};
});
vi.mock('$lib/profile/context', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/profile/context')>();
	return {
		...real,
		setProfileApp: (app: ProfileApp) => {
			harness.app = app;
			real.setProfileApp(app);
		}
	};
});
vi.mock('$lib/profile/idle-timer', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/profile/idle-timer')>();
	return {
		...real,
		createIdleTimer: (opts: IdleTimerOptions) => {
			harness.idle.push(opts);
			return real.createIdleTimer(opts);
		}
	};
});

const children = createRawSnippet(() => ({ render: () => '<p>page</p>' }));
let db: IDBDatabase | null = null;

/** A device whose saved profile body is gone while its mark says one was saved: the data the app calls damaged. */
async function damagedDevice(): Promise<IDBDatabase> {
	const opened = await openTestDb();
	await bootstrapLocalKeystore(opened);
	await createProfileStore(opened).save({
		eaos: new TextEncoder().encode('2027-04-15'),
		setupIntent: 'completed'
	});
	await new Promise<void>((resolve, reject) => {
		const tx = opened.transaction('profile', 'readwrite');
		tx.objectStore('profile').delete(0);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	return opened;
}

function appNow(): ProfileApp {
	if (harness.app === null) throw new Error('test setup: the layout set no app');
	return harness.app;
}

/** Holds every navigation the page starts, recording where it was going. */
function holdNavigation() {
	const seen: { type: string; path: string }[] = [];
	const target = (window as unknown as { navigation: EventTarget }).navigation;
	const hold = (e: Event): void => {
		const nav = e as Event & { navigationType: string; destination: { url: string } };
		seen.push({ type: nav.navigationType, path: new URL(nav.destination.url).pathname });
		e.preventDefault();
	};
	target.addEventListener('navigate', hold);
	return { seen, release: () => target.removeEventListener('navigate', hold) };
}

function joiner() {
	return { relockSync: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(async () => {
	harness.app = null;
	harness.idle.length = 0;
	db = await damagedDevice();
	harness.db = Promise.resolve(db);
	// The test page has no service worker file to register.
	vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue({} as ServiceWorkerRegistration);
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
});

describe('the root layout, when the saved data cannot be read', () => {
	// Check (a backup row) joins this list; Erase's first step and the idle timer must reach it before anything is wiped.
	it('installs a lifecycle with an idle timer, so a joined session is relocked like any other', async () => {
		await render(Layout, { children });
		await vi.waitFor(() => expect(appNow().joinRelock).not.toBeNull());
		const app = appNow();
		expect(app.status).toBe('damaged');
		expect(app.relockAll).not.toBeNull();

		const session = joiner();
		app.joinRelock?.(session);
		window.dispatchEvent(new Event('pagehide'));
		expect(session.relockSync).toHaveBeenLastCalledWith('hygiene');
		app.relockAll?.();
		expect(session.relockSync).toHaveBeenLastCalledWith('user');

		expect(harness.idle).toHaveLength(1);
		expect(harness.idle[0]?.thresholdMs).toBe(IDLE_THRESHOLD_MS);
		harness.idle[0]?.onIdle();
		expect(session.relockSync).toHaveBeenLastCalledWith('idle');
	});

	// There is no restore under damage, so nothing may let a backup row publish, and a reload still follows any peer.
	it('leaves publish null, still reloads when a peer signals, and stops all of it when unmounted', async () => {
		const held = holdNavigation();
		const peer = createProfileBus();
		try {
			const { unmount } = await render(Layout, { children });
			await vi.waitFor(() => expect(appNow().joinRelock).not.toBeNull());
			const app = appNow();
			expect(app.publish).toBeNull();

			peer.publish({ type: 'profile-updated' });
			await vi.waitFor(() =>
				expect(held.seen).toEqual([expect.objectContaining({ type: 'reload' })])
			);

			const session = joiner();
			app.joinRelock?.(session);
			unmount();
			window.dispatchEvent(new Event('pagehide'));
			expect(session.relockSync).not.toHaveBeenCalled();
		} finally {
			peer.close();
			held.release();
		}
	});
});
