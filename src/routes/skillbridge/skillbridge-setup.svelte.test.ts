import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { createFinderStore } from '$lib/skillbridge-finder/state/store.svelte';
import { createFinderPackStore } from '$lib/skillbridge-finder/state/pack-store.svelte';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import SkillBridgePage from './+page.svelte';

// The page runs on the real finder record and pack over a test database; only the app container the layout would hand
// it is replaced, so each case can set the lock and the load state.
const harness = vi.hoisted(() => ({ app: null as ProfileApp | null }));
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => harness.app,
	setProfileApp: () => {}
}));

const START_URL = location.href;
let db: IDBDatabase | null = null;

/** A device with no profile at all, as a first visit: the finder needs only its own record and the keystore. */
async function device(overrides: Partial<ProfileApp> = {}) {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	const store = createProfileStore(db);
	await store.load();
	const finder = createFinderStore(db);
	await finder.load();
	const pack = createFinderPackStore(db);
	await pack.load();
	const app: ProfileApp = {
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
		replacedNotice: false,
		...overrides
	};
	harness.app = app;
	return { app, finder, pack, store };
}

const field = () => page.getByLabelText('ZIP code or state');
const show = () => page.getByRole('button', { name: 'Show programs' });

beforeEach(() => {
	harness.app = null;
});

afterEach(async () => {
	history.replaceState(history.state, '', START_URL);
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
});

describe('the first visit', () => {
	it('shows the heading and the one-screen setup with no profile at all', async () => {
		await device();
		await render(SkillBridgePage);

		await expect
			.element(page.getByRole('heading', { level: 1, name: 'SkillBridge' }))
			.toBeVisible();
		await expect.element(field()).toBeVisible();
		expect(page.getByText('Timeline').elements()).toHaveLength(0);
	});

	it('Skip all keeps the choice and takes the setup away', async () => {
		const { finder } = await device();
		await render(SkillBridgePage);
		await page.getByRole('button', { name: 'Skip all' }).click();

		await vi.waitFor(() => expect(finder.setup).toEqual({ territories: false, overseas: false }));
		await expect.element(field()).not.toBeInTheDocument();
	});

	it('saves a state, the formats and the fields into the record', async () => {
		const { finder } = await device();
		await render(SkillBridgePage);
		await field().fill('Maryland');
		await page.getByRole('button', { name: 'Hybrid' }).click();
		await page.getByRole('button', { name: 'Management' }).click();
		await show().click();

		await vi.waitFor(() =>
			expect(finder.setup).toEqual({
				place: { kind: 'state', state: 'MD' },
				territories: false,
				overseas: false
			})
		);
		expect(finder.filters).toEqual({ delivery: [3], industries: ['Management'] });
	});

	// What was typed is the person's own: it must not reach history, the address bar or a log.
	it('leaves the address as it was after typing and saving', async () => {
		await device();
		await render(SkillBridgePage);
		await field().fill('Maryland');
		await userEvent.keyboard('{Enter}');
		await expect.element(field()).not.toBeInTheDocument();

		expect(location.href).toBe(START_URL);
	});
});

describe('changing the setup', () => {
	it('shows it again, filled in, on #setup, and keeps the filters the list owns', async () => {
		const { finder } = await device();
		await finder.setSetup({
			place: { kind: 'state', state: 'TX' },
			territories: false,
			overseas: false
		});
		await finder.setFilters({ branches: ['Navy'], delivery: [1] });
		history.replaceState(history.state, '', `${location.pathname}${location.search}#setup`);
		await render(SkillBridgePage);

		await expect.element(field()).toHaveValue('Texas');
		await field().fill('Virginia');
		// The saved format is shown chosen; turning it off drops it from the record.
		await expect
			.element(page.getByRole('button', { name: 'In person' }))
			.toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('button', { name: 'In person' }).click();
		await show().click();

		// The setup closes once both its writes have landed (the place, then the filters it owns).
		await expect.element(field()).not.toBeInTheDocument();
		expect(finder.setup.place).toEqual({ kind: 'state', state: 'VA' });
		expect(finder.filters).toEqual({ branches: ['Navy'] });
		// The address goes back to the plain page, so a reload does not open the setup again.
		expect(location.hash).toBe('');
	});

	it('does not show the setup on an ordinary visit once it was done', async () => {
		const { finder } = await device();
		await finder.setSetup({ territories: false, overseas: false });
		await render(SkillBridgePage);

		await expect
			.element(page.getByRole('heading', { level: 1, name: 'SkillBridge' }))
			.toBeVisible();
		await expect.element(page.getByText('Listings from DoD SkillBridge')).toBeVisible();
		expect(field().elements()).toHaveLength(0);
	});
});

describe('a locked or unreadable finder', () => {
	it('shows the locked panel, and Unlock reads the record again', async () => {
		const { app, finder } = await device();
		await finder.setSetup({ territories: false, overseas: false });
		app.store?.relockSync('user');
		finder.relockSync('user');
		app.finderPack?.relockSync('user');
		await render(SkillBridgePage);

		await expect.element(page.getByText('Your data is locked')).toBeVisible();
		expect(field().elements()).toHaveLength(0);
		await page.getByRole('button', { name: 'Unlock' }).click();

		await vi.waitFor(() => expect(finder.ready).toBe(true));
		await expect.element(page.getByText('Your data is locked')).not.toBeInTheDocument();
		expect(app.finderPack?.ready).toBe(true);
	});

	it('says so when the finder code failed to load, and does not wait for ever', async () => {
		await device({ finder: null, finderPack: null, finderFailed: true });
		await render(SkillBridgePage);

		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent("The SkillBridge finder couldn't be loaded. Reload to try again.");
		expect(field().elements()).toHaveLength(0);
	});

	it('says so when the saved record could not be read, and offers a reload', async () => {
		const { finder } = await device();
		// A body with no marker: the store refuses to read it as empty.
		await new Promise<void>((resolve, reject) => {
			const tx = db!.transaction('skillbridge-finder', 'readwrite');
			tx.objectStore('skillbridge-finder').put({ id: 0, rec: new Uint8Array(8) });
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		await finder.load().catch(() => undefined);
		await render(SkillBridgePage);

		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent("Your saved SkillBridge choices couldn't be read. Reload to try again.");
		await expect.element(page.getByRole('button', { name: 'Reload' })).toBeVisible();
	});

	it('waits quietly, showing only the heading, until the finder has loaded', async () => {
		await device({ finder: null, finderPack: null });
		await render(SkillBridgePage);

		await expect
			.element(page.getByRole('heading', { level: 1, name: 'SkillBridge' }))
			.toBeVisible();
		expect(field().elements()).toHaveLength(0);
		expect(page.getByRole('alert').elements()).toHaveLength(0);
	});
});
