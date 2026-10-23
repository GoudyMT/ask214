import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { createFinderStore } from '$lib/skillbridge-finder/state/store.svelte';
import { createFinderPackStore } from '$lib/skillbridge-finder/state/pack-store.svelte';
import { network } from '$lib/skillbridge-finder/ui/list-world';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import SkillBridgePage from './+page.svelte';

// A held week that cannot be read (a row written under a key this device no longer has): the pack fails to load, and
// the page must still recover it and show the week, not wait on it for ever.
const harness = vi.hoisted(() => ({ app: null as ProfileApp | null }));
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => harness.app,
	setProfileApp: () => {}
}));

const START_URL = location.href;
let db: IDBDatabase | null = null;
let net: ReturnType<typeof network>;

beforeEach(() => {
	net = network();
	vi.spyOn(globalThis, 'fetch').mockImplementation((input) => net.fetchFn(String(input), {}));
});

afterEach(async () => {
	history.replaceState(history.state, '', START_URL);
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
});

describe('a held week that cannot be read', () => {
	it('is dropped and downloaded again, so the listings show instead of "Loading listings..."', async () => {
		db = await openTestDb();
		await bootstrapLocalKeystore(db);
		const store = createProfileStore(db);
		await store.load();
		const finder = createFinderStore(db);
		await finder.load();
		await finder.setSetup({
			place: { kind: 'state', state: 'MD' },
			territories: false,
			overseas: false
		});
		const tx = db.transaction('skillbridge-finder-pack', 'readwrite');
		tx.objectStore('skillbridge-finder-pack').put({ id: 'index', rec: new Uint8Array(32) });
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(new Error('E_TEST_WRITE'));
		});
		const pack = createFinderPackStore(db);
		await pack.load().catch(() => undefined);
		expect(pack.failed).toBe(true);
		harness.app = {
			status: 'ready',
			store,
			timeline: null,
			calendar: null,
			finder,
			finderPack: pack,
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

		await render(SkillBridgePage);

		await expect.element(page.getByText('6 programs', { exact: true })).toBeVisible();
		expect(page.getByText('Loading listings...').elements()).toHaveLength(0);
	});
});
