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

// The page over the real stores and a fake network that serves a small published week: what a person sees after
// setup, and across a Lock.
const harness = vi.hoisted(() => ({ app: null as ProfileApp | null }));
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => harness.app,
	setProfileApp: () => {}
}));

const START_URL = location.href;
let db: IDBDatabase | null = null;
let net: ReturnType<typeof network>;

async function device() {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	const store = createProfileStore(db);
	await store.load();
	const finder = createFinderStore(db);
	await finder.load();
	const pack = createFinderPackStore(db);
	await pack.load();
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
	return { store, finder, pack };
}

const programs = (n: number) => page.getByText(`${n} programs`, { exact: true });

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

describe('from setup to the list', () => {
	it('shows the programs for the state just chosen, fetching only the files that state needs', async () => {
		await device();
		await render(SkillBridgePage);
		await page.getByLabelText('ZIP code or state').fill('Maryland');
		await page.getByRole('button', { name: 'Show programs' }).click();

		await expect.element(programs(6)).toBeVisible();
		await expect
			.element(
				page.getByText('Listings from Oct 21, 2026').or(page.getByText(/These listings are from/))
			)
			.toBeVisible();
		expect(net.calls.some((c) => c.endsWith('/south-atlantic.json'))).toBe(true);
		expect(net.calls.some((c) => c.endsWith('/pacific.json'))).toBe(false);
	});

	it('opens straight onto the list for a person who finished setup before', async () => {
		const { finder } = await device();
		await finder.setSetup({
			place: { kind: 'state', state: 'MD' },
			territories: false,
			overseas: false
		});
		await render(SkillBridgePage);

		await expect.element(programs(6)).toBeVisible();
		expect(page.getByLabelText('ZIP code or state').elements()).toHaveLength(0);
	});

	it('shows the new place after Change, without a second visit', async () => {
		const { finder } = await device();
		await finder.setSetup({
			place: { kind: 'state', state: 'MD' },
			territories: false,
			overseas: false
		});
		history.replaceState(history.state, '', `${location.pathname}${location.search}#setup`);
		await render(SkillBridgePage);
		await page.getByLabelText('ZIP code or state').fill('Virginia');
		await page.getByRole('button', { name: 'Show programs' }).click();

		await vi.waitFor(() => expect(finder.setup.place).toEqual({ kind: 'state', state: 'VA' }));
		await expect.element(page.getByRole('button', { name: 'Remove In Virginia' })).toBeVisible();
	});
});

describe('across a Lock', () => {
	it('swaps the list for the locked panel, and brings it back on Unlock', async () => {
		const { store, finder, pack } = await device();
		await finder.setSetup({
			place: { kind: 'state', state: 'MD' },
			territories: false,
			overseas: false
		});
		await render(SkillBridgePage);
		await expect.element(programs(6)).toBeVisible();

		store.relockSync('user');
		finder.relockSync('user');
		pack.relockSync('user');
		await expect.element(page.getByText('Your data is locked')).toBeVisible();
		expect(page.getByText('Alpha Systems').elements()).toHaveLength(0);

		await page.getByRole('button', { name: 'Unlock' }).click();
		await expect.element(programs(6)).toBeVisible();
		await expect.element(page.getByText('Your data is locked')).not.toBeInTheDocument();
	});
});
