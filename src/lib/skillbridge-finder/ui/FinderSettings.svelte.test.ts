import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ProfileApp } from '$lib/profile/context';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { REGION_FILE_NAMES, dataPath } from '../contract/places';
import type { FinderSetup } from '../state/types';
import FinderSettings from './FinderSettings.svelte';
import { PULL, device, network, startedSession } from './list-world';

// The offline-pack rows of Settings over the real stores on a test database, with a fake network serving a small week:
// 4 files of 1 MB each are what a Maryland setup needs (its division, the many-state, remote and unplaced files).
const harness = vi.hoisted(() => ({ app: null as ProfileApp | null }));
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => harness.app,
	setProfileApp: () => {}
}));

const MARYLAND: FinderSetup = {
	place: { kind: 'state', state: 'MD' },
	territories: false,
	overseas: false
};
const INDEX_PATH = dataPath({ kind: 'index' });
const ZIPS_PATH = dataPath({ kind: 'table', name: 'zips' });
const REGION_PATHS: string[] = REGION_FILE_NAMES.map((name) =>
	dataPath({ kind: 'region', pullDate: PULL, name })
);
const ALLOWED = new Set<string>([
	INDEX_PATH,
	ZIPS_PATH,
	dataPath({ kind: 'ids', pullDate: PULL }),
	dataPath({ kind: 'changes', pullDate: PULL }),
	...REGION_PATHS
]);

let db: IDBDatabase | null = null;
let net: ReturnType<typeof network>;

/** The stores on a fresh database, `setup` saved; the week already held when `held`. */
async function world(setup: FinderSetup, held: boolean) {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	const dev = await device(db, setup);
	if (held) await startedSession(dev, net);
	net.calls.length = 0;
	harness.app = { finder: dev.finder, finderPack: dev.pack } as unknown as ProfileApp;
	return dev;
}

beforeEach(() => {
	net = network();
	vi.spyOn(globalThis, 'fetch').mockImplementation((input) => net.fetchFn(String(input), {}));
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
});

describe('FinderSettings', () => {
	it('says "Not set up" for a person who has not been through setup, and still offers the save', async () => {
		await world({}, false);
		await render(FinderSettings);

		await expect.element(page.getByText('Not set up')).toBeVisible();
		await expect.element(page.getByRole('button', { name: /Save for offline/ })).toBeVisible();
	});

	it('words the setup, with a link that goes to the setup screen', async () => {
		await world(MARYLAND, false);
		await render(FinderSettings);

		await expect.element(page.getByText('In Maryland')).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: 'Change' }))
			.toHaveAttribute('href', '/skillbridge#setup');
	});

	it('shows the size and the date of a held week as On', async () => {
		await world(MARYLAND, true);
		await render(FinderSettings);

		await expect.element(page.getByText('On - 4.0 MB, from Oct 21, 2026')).toBeVisible();
		expect(page.getByRole('button', { name: /Save for offline/ }).elements()).toHaveLength(0);
	});

	it('tells the size of a save before downloading any listing file', async () => {
		await world(MARYLAND, false);
		await render(FinderSettings);

		await expect
			.element(page.getByRole('button', { name: 'Save for offline (about 4.0 MB)' }))
			.toBeVisible();
		// Only the index was asked for: the size comes from it, and no region file is fetched until the tap.
		expect(net.calls).toEqual([INDEX_PATH]);
	});

	it('needs only the index and the ZIP table to size a save for a ZIP, and no region file', async () => {
		await world(
			{ place: { kind: 'zip', zip: '21046' }, radius: 100, territories: false, overseas: false },
			false
		);
		await render(FinderSettings);

		await expect.element(page.getByText('Near 21046, within 100 mi')).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: /Save for offline \(about \d+\.\d MB\)/ }))
			.toBeVisible();
		expect(net.calls.every((c) => c === INDEX_PATH || c === ZIPS_PATH)).toBe(true);
	});

	it('downloads only fixed data paths when saved, then shows On', async () => {
		const { pack } = await world(MARYLAND, false);
		await render(FinderSettings);
		await page.getByRole('button', { name: /Save for offline/ }).click();

		await expect.element(page.getByText('On - 4.0 MB, from Oct 21, 2026')).toBeVisible();
		expect(pack.index?.pullDate).toBe(PULL);
		expect(net.calls.length).toBeGreaterThan(1);
		for (const call of net.calls) expect(ALLOWED, call).toContain(call);
		expect(net.calls).toContain(
			dataPath({ kind: 'region', pullDate: PULL, name: 'south-atlantic' })
		);
	});

	it('removes the held week, empties the pack and offers the save again', async () => {
		const { pack } = await world(MARYLAND, true);
		await render(FinderSettings);
		await page.getByRole('button', { name: 'Remove' }).click();

		await expect
			.element(page.getByRole('button', { name: 'Save for offline (about 4.0 MB)' }))
			.toBeVisible();
		expect(pack.index).toBeUndefined();
		await expect.element(page.getByText('Off', { exact: true })).toBeVisible();
	});

	it('shows nothing of the person while locked', async () => {
		const { finder, pack } = await world(MARYLAND, true);
		await render(FinderSettings);
		await expect.element(page.getByText('In Maryland')).toBeVisible();

		finder.relockSync('user');
		pack.relockSync('user');

		await vi.waitFor(() => expect(document.body.textContent).not.toContain('Maryland'));
		expect(document.body.textContent).not.toContain('MB');
		expect(page.getByRole('heading', { name: 'SkillBridge finder' }).elements()).toHaveLength(0);
	});
});
