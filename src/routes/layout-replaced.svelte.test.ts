import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from '$app/paths';
import type { ProfileApp } from '#lib/profile/context.js';
import { createProfileStore } from '#lib/profile/store.svelte.js';
import { BackupSession } from '#lib/backup/session.svelte.js';
import { createProfileBus } from '#lib/broadcast/bus.js';
import { bootstrapLocalKeystore } from '#lib/keystore/bootstrap.js';
import { deleteTestDb, openTestDb } from '#lib/db/_test-helpers.js';
import Layout from './+layout.svelte';

// The layout runs the real start-up on a test database and a real BroadcastChannel carries the peer's signal; only the
// database it opens and the app container it sets (to read it) are intercepted. A reload or a replace cannot run in
// the test page, so every navigation is held at the browser's own navigate event and recorded.
const harness = vi.hoisted(() => ({
	db: null as Promise<IDBDatabase> | null,
	app: null as ProfileApp | null
}));

// The layout opens the default database (no name); the test helpers open a named one, which stays real.
vi.mock('#lib/db/schema.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/db/schema.js')>();
	return {
		...real,
		openMtcDb: (...args: Parameters<typeof real.openMtcDb>) =>
			args[0] === undefined ? harness.db : real.openMtcDb(...args)
	};
});
vi.mock('#lib/profile/context.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/profile/context.js')>();
	return {
		...real,
		setProfileApp: (app: ProfileApp) => {
			harness.app = app;
			real.setProfileApp(app);
		}
	};
});

const children = createRawSnippet(() => ({ render: () => '<p>page</p>' }));
const REPLACED_LINE =
	'Data on this device was replaced from a backup in another tab. Reload to see it.';
const START_URL = location.href;
let db: IDBDatabase | null = null;
let peer: ReturnType<typeof createProfileBus> | null = null;
let release: (() => void) | null = null;

async function device(withProfile: boolean): Promise<void> {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	if (withProfile) {
		await createProfileStore(db).save({
			eaos: new TextEncoder().encode('2027-04-15'),
			setupIntent: 'completed'
		});
	}
	harness.db = Promise.resolve(db);
}

/** The layout's app once start-up has finished and any saved profile is in memory. */
async function readyApp(withProfile: boolean): Promise<ProfileApp> {
	await vi.waitFor(() => {
		expect(harness.app?.status).toBe('ready');
		expect(harness.app?.publish).not.toBeNull();
		if (withProfile) expect(harness.app?.store?._getStateForTest()).not.toBeNull();
	});
	if (harness.app === null) throw new Error('test setup: the layout set no app');
	return harness.app;
}

/** Holds every navigation the page starts, recording where it was going; `onNavigate` runs as each one starts. */
function holdNavigation(onNavigate: () => void = () => {}) {
	const seen: { type: string; path: string }[] = [];
	const target = (window as unknown as { navigation: EventTarget }).navigation;
	const hold = (e: Event): void => {
		const nav = e as Event & { navigationType: string; destination: { url: string } };
		seen.push({ type: nav.navigationType, path: new URL(nav.destination.url).pathname });
		onNavigate();
		e.preventDefault();
	};
	target.addEventListener('navigate', hold);
	release = () => target.removeEventListener('navigate', hold);
	return seen;
}

/** The page hidden or shown, as the tab switcher does it. */
function setHidden(hidden: boolean): void {
	Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => (hidden ? 'hidden' : 'visible')
	});
	document.dispatchEvent(new Event('visibilitychange'));
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
	harness.app = null;
	peer = createProfileBus();
	// The test page has no service worker file to register.
	vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue({} as ServiceWorkerRegistration);
});

afterEach(async () => {
	release?.();
	release = null;
	peer?.close();
	peer = null;
	delete (document as unknown as Record<string, unknown>).hidden;
	delete (document as unknown as Record<string, unknown>).visibilityState;
	history.replaceState(history.state, '', START_URL);
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
});

describe('the root layout, when another tab restored a backup', () => {
	// A reload decrypts, so a locked tab never reloads itself; the only plaintext it could hold is what the lock removed.
	it('a locked peer holds no plaintext after data-replaced and being shown, and does not reload', async () => {
		await device(true);
		await render(Layout, { children });
		const app = await readyApp(true);
		await app.store?.lock('idle');
		expect(app.store?.locked).toBe(true);
		const seen = holdNavigation();

		setHidden(true);
		peer?.publish({ type: 'data-replaced' });
		await vi.waitFor(() => expect(app.reloadOnUnlock).toBe(true));
		setHidden(false);
		await pause(100);

		expect(app.store?._getStateForTest()).toBeNull();
		expect(app.replacedNotice).toBe(false);
		expect(seen).toEqual([]);
	});

	it('an unlocked peer drops its plaintext, and the sessions in it, before it reloads', async () => {
		await device(true);
		await render(Layout, { children });
		const app = await readyApp(true);
		const session = { relockSync: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) };
		app.joinRelock?.(session);
		let heldAtReload: unknown = 'not recorded';
		const seen = holdNavigation(() => (heldAtReload = app.store?._getStateForTest()));

		peer?.publish({ type: 'data-replaced' });
		await vi.waitFor(() => expect(seen).toHaveLength(1));

		expect(seen[0]?.type).toBe('reload');
		expect(heldAtReload).toBeNull();
		expect(session.relockSync).toHaveBeenCalledWith('hygiene');
		expect(app.reloadOnUnlock).toBe(false);
	});

	// No Unlock button exists on a first-run tab, so the line has to be there for it; opening itself would decrypt.
	it('a first-run peer, idle-locked, receiving data-replaced shows the Reload line and does not reload', async () => {
		await device(false);
		await render(Layout, { children });
		const app = await readyApp(false);
		await app.store?.lock('idle');
		expect(app.store?.lockState).toBe('locked');
		expect(app.store?.locked).toBe(false);
		const seen = holdNavigation();

		peer?.publish({ type: 'data-replaced' });
		await expect.element(page.getByRole('status')).toHaveTextContent(`${REPLACED_LINE} Reload`);
		expect(seen).toEqual([]);
		expect(app.reloadOnUnlock).toBe(false);

		await userEvent.click(page.getByRole('button', { name: 'Reload' }));
		expect(seen).toEqual([{ type: 'replace', path: resolve('timeline') }]);
	});

	// The wizard would save its form over the restored date if it booted again, so the peer leaves it for the Timeline.
	it('a peer on /wizard replaces to /timeline instead of reloading', async () => {
		await device(false);
		await render(Layout, { children });
		await readyApp(false);
		history.replaceState(history.state, '', resolve('wizard'));
		const seen = holdNavigation();

		peer?.publish({ type: 'data-replaced' });
		await vi.waitFor(() => expect(seen).toHaveLength(1));

		expect(seen).toEqual([{ type: 'replace', path: resolve('timeline') }]);
	});

	// A hidden tab waits to be shown; if the layout is gone by then, that wait must have been taken down with it.
	it('a layout that is gone does not reload when the page is next shown', async () => {
		await device(true);
		const { unmount } = await render(Layout, { children });
		await readyApp(true);
		const seen = holdNavigation();

		setHidden(true);
		peer?.publish({ type: 'data-replaced' });
		await pause(100);
		unmount();
		setHidden(false);
		await pause(100);

		expect(seen).toEqual([]);
	});

	it('hands the restore a way to tell the other tabs', async () => {
		await device(false);
		const heard: string[] = [];
		peer?.subscribe((s) => heard.push(s.type));
		await render(Layout, { children });
		const app = await readyApp(false);

		app.publish?.({ type: 'data-replaced' });

		await vi.waitFor(() => expect(heard).toEqual(['data-replaced']));
	});
});

describe('the root layout, when another tab locks with a backup session open here', () => {
	/**
	 * A real session joined through the layout's own joinRelock, and a real store in the "other tab" that broadcasts
	 * through the same channel, so the reason on the wire is the one a real idle or Lock puts there and the layout's
	 * relocked handler is the one that passes it on.
	 */
	async function sessionAndPeerStore() {
		await device(true);
		await render(Layout, { children });
		const app = await readyApp(true);
		const session = new BackupSession({ isVisible: () => true, hasFocus: () => true });
		session.start(app, 'export');
		await session.showPassphrase();
		session.enterPhase('typed-back');
		const peerStore = createProfileStore(db as IDBDatabase, {
			onBroadcast: (e) => peer?.publish(e)
		});
		await peerStore.load();
		return { app, session, peerStore };
	}

	// The person is typing the words back here; a background tab timing out must not cost them the session, though the
	// profile itself still locks everywhere (shipped).
	it('a peer idle lock leaves a session that holds no key alone', async () => {
		const { app, session, peerStore } = await sessionAndPeerStore();
		await peerStore.lock('idle');
		await vi.waitFor(() => expect(app.store?.lockState).toBe('locked'));
		expect(session.phase).toBe('typed-back');
		expect(session.message).toBeNull();
		expect(session.concealed).toBe(false);
		expect(session.words).toHaveLength(6);
		session.end();
	});

	// Locking by hand is a decision to be rid of what is open, so the same signal without the reason clears the words.
	it('a peer Lock clears it and says so', async () => {
		const { session, peerStore } = await sessionAndPeerStore();
		await peerStore.lock('user');
		await vi.waitFor(() => expect(session.phase).toBe('idle'));
		expect(session.message).toBe('E_LOCKED');
		expect(session.words).toBeNull();
	});
});
