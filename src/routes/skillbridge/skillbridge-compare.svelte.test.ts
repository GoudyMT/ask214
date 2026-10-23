import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ProfileApp } from '$lib/profile/context';
import { createProfileStore } from '$lib/profile/store.svelte';
import { createFinderStore } from '$lib/skillbridge-finder/state/store.svelte';
import { createFinderPackStore } from '$lib/skillbridge-finder/state/pack-store.svelte';
import { ALPHA, BRAVO, network } from '$lib/skillbridge-finder/ui/list-world';
import { cleanListing } from '$lib/skillbridge-finder/fixtures/clean';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import SkillBridgePage from './+page.svelte';

// The page's Compare: picks made on the cards, the tray, the table that replaces the list, and the way back.
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
	await finder.setSetup({
		place: { kind: 'state', state: 'MD' },
		territories: false,
		overseas: false
	});
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
const tray = () => page.getByText(/of 3 picked/);
const columns = () => [...document.querySelectorAll('thead th[scope="col"]')];

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

describe('the compare tray', () => {
	it('appears with the second pick, not the first, and counts the picks', async () => {
		await device();
		await render(SkillBridgePage);
		await expect.element(programs(6)).toBeVisible();

		await page.getByRole('button', { name: 'Compare', exact: true }).first().click();
		await expect.element(page.getByRole('button', { name: 'Comparing' })).toBeVisible();
		expect(tray().elements()).toHaveLength(0);

		await page.getByRole('button', { name: 'Compare', exact: true }).first().click();
		await expect.element(tray()).toHaveTextContent('2 of 3 picked');
	});
});

describe('the compare table on the page', () => {
	it('opens from the tray with one column per pick, in place of the list', async () => {
		const { finder } = await device();
		await finder.addCompare(ALPHA.i);
		await finder.addCompare(BRAVO.i);
		await render(SkillBridgePage);
		await expect.element(tray()).toBeVisible();

		await page.getByRole('button', { name: 'Compare', exact: true }).last().click();

		await expect.element(page.getByRole('heading', { name: 'Compare programs' })).toBeVisible();
		expect(columns().map((c) => c.textContent)).toEqual([
			expect.stringContaining('Alpha Systems'),
			expect.stringContaining('Bravo Health')
		]);
		expect(page.getByRole('heading', { name: 'SkillBridge', exact: true }).elements()).toHaveLength(
			0
		);
		expect(tray().elements()).toHaveLength(0);
		// The list stays mounted underneath, so its place is kept, but it is hidden from sight and from assistive tech.
		expect(page.getByRole('tab').elements()).toHaveLength(0);
	});

	it('removes a pick through the record, and Back returns to the list with the tray gone', async () => {
		const { finder } = await device();
		await finder.addCompare(ALPHA.i);
		await finder.addCompare(BRAVO.i);
		await render(SkillBridgePage);
		await page.getByRole('button', { name: 'Compare', exact: true }).last().click();

		await page.getByRole('button', { name: 'Remove Alpha Systems' }).click();
		await vi.waitFor(() => expect(finder.compare).toEqual([BRAVO.i]));
		expect(columns()).toHaveLength(1);

		await page.getByRole('button', { name: 'Back to programs' }).click();
		await expect.element(programs(6)).toBeVisible();
		expect(tray().elements()).toHaveLength(0);
		await expect.element(page.getByRole('button', { name: 'Comparing' })).toBeVisible();
	});

	// A write that fails (a full disk, a lock in another tab) must not leave the table showing a removal that never
	// happened: it says so, and the columns stay those of the saved record.
	it('says so and keeps the saved picks when a removal cannot be saved', async () => {
		const { finder } = await device();
		await finder.addCompare(ALPHA.i);
		await finder.addCompare(BRAVO.i);
		vi.spyOn(finder, 'removeCompare').mockRejectedValue(new Error('E_TEST_WRITE'));
		await render(SkillBridgePage);
		await page.getByRole('button', { name: 'Compare', exact: true }).last().click();

		await page.getByRole('button', { name: 'Remove Alpha Systems' }).click();

		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Could not save that change. Try again.');
		expect(finder.compare).toEqual([ALPHA.i, BRAVO.i]);
		expect(columns()).toHaveLength(2);
	});

	it('clears every pick with Clear all and goes back to the list', async () => {
		const { finder } = await device();
		await finder.addCompare(ALPHA.i);
		await finder.addCompare(BRAVO.i);
		await render(SkillBridgePage);
		await page.getByRole('button', { name: 'Compare', exact: true }).last().click();

		await page.getByRole('button', { name: 'Clear all' }).click();

		await expect.element(programs(6)).toBeVisible();
		expect(finder.compare).toEqual([]);
		expect(page.getByRole('heading', { name: 'Compare programs' }).elements()).toHaveLength(0);
	});

	it('goes back to the list for Add another, keeping the picks', async () => {
		const { finder } = await device();
		await finder.addCompare(ALPHA.i);
		await finder.addCompare(BRAVO.i);
		await render(SkillBridgePage);
		await page.getByRole('button', { name: 'Compare', exact: true }).last().click();

		await page.getByRole('button', { name: 'Add another' }).click();

		await expect.element(programs(6)).toBeVisible();
		expect(finder.compare).toEqual([ALPHA.i, BRAVO.i]);
		await expect.element(tray()).toHaveTextContent('2 of 3 picked');
	});

	it('says a pick the weekly files no longer list is no longer listed, from its saved facts', async () => {
		const { finder } = await device();
		const gone = cleanListing({
			i: 9001,
			n: 'Zulu Shipyard',
			p: 'Welder Apprenticeship',
			s: 'MD',
			ls: ['MD']
		});
		await finder.save(gone, '2026-10-01');
		await finder.addCompare(gone.i);
		await finder.addCompare(ALPHA.i);
		await render(SkillBridgePage);
		await page.getByRole('button', { name: 'Compare', exact: true }).last().click();

		const [first, second] = columns();
		expect(first?.textContent).toContain('Zulu Shipyard');
		expect(first?.textContent).toContain('No longer listed');
		expect(second?.textContent).not.toContain('No longer listed');
	});

	it('holds the place in a long list across the table and back', async () => {
		net = network(30);
		const { finder } = await device();
		await finder.addCompare(ALPHA.i);
		await finder.addCompare(BRAVO.i);
		await render(SkillBridgePage);
		await expect.element(page.getByText('36 programs', { exact: true })).toBeVisible();
		window.scrollTo(0, 600);
		await vi.waitFor(() => expect(window.scrollY).toBe(600));

		await page.getByRole('button', { name: 'Compare', exact: true }).last().click();
		await expect.element(page.getByRole('heading', { name: 'Compare programs' })).toBeVisible();
		await page.getByRole('button', { name: 'Back to programs' }).click();

		await expect.element(page.getByText('36 programs', { exact: true })).toBeVisible();
		await vi.waitFor(() => expect(window.scrollY).toBe(600));
	});
});

describe('across a Lock with the table open', () => {
	it('shows no listing while locked, and the list again after Unlock', async () => {
		const { store, finder, pack } = await device();
		await finder.addCompare(ALPHA.i);
		await finder.addCompare(BRAVO.i);
		await render(SkillBridgePage);
		await page.getByRole('button', { name: 'Compare', exact: true }).last().click();
		await expect.element(page.getByRole('heading', { name: 'Compare programs' })).toBeVisible();

		store.relockSync('user');
		finder.relockSync('user');
		pack.relockSync('user');
		await expect.element(page.getByText('Your data is locked')).toBeVisible();
		expect(document.body.textContent).not.toContain('Alpha Systems');
		expect(document.body.textContent).not.toContain('Bravo Health');

		await page.getByRole('button', { name: 'Unlock' }).click();
		await expect.element(programs(6)).toBeVisible();
		expect(page.getByRole('heading', { name: 'Compare programs' }).elements()).toHaveLength(0);
	});
});
