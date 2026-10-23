import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLocalKeystore } from '../../keystore/bootstrap';
import { deleteTestDb, openTestDb } from '../../db/_test-helpers';
import type { FetchFn } from '../fetch/fetch-files';
import { createFinderPackStore, type FinderPackStore } from '../state/pack-store.svelte';
import { createFinderStore, type FinderStore } from '../state/store.svelte';
import type { FinderFilters, FinderSetup } from '../state/types';
import { NOW, device, network, startedSession } from './list-world';
import FinderHomeRow from './FinderHomeRow.svelte';

// The row runs on a real finder record, pack and session over a small published week (see list-world.ts). Only the
// network and the service worker question are handed to the session, as session.browser.test.ts hands them.
const world = vi.hoisted(() => ({ fetchFn: null as FetchFn | null }));
vi.mock('$lib/skillbridge-finder/ui/session.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('./session.svelte')>();
	return {
		...real,
		createFinderSession: (opts: Parameters<typeof real.createFinderSession>[0]) =>
			real.createFinderSession({
				...opts,
				fetchFn: world.fetchFn!,
				workerPassesData: () => Promise.resolve(true)
			})
	};
});

// The profile app the layout would provide: the finder's stores are real, the app's own flags are set per test.
const flags = $state({ finderFailed: false, lockState: 'unlocked' });
const held: { finder: FinderStore | null; pack: FinderPackStore | null } = {
	finder: null,
	pack: null
};
const app = {
	get finder() {
		return held.finder;
	},
	get finderPack() {
		return held.pack;
	},
	get finderFailed() {
		return flags.finderFailed;
	},
	store: {
		get lockState() {
			return flags.lockState;
		}
	}
};
vi.mock('$lib/profile/context', () => ({ getProfileApp: () => app, setProfileApp: () => {} }));

const SET_UP: FinderSetup = {
	place: { kind: 'state', state: 'MD' },
	territories: false,
	overseas: false
};
// Five of the week's six programs are in person or hybrid; the remote one is left out so the counts are plain.
const IN_PERSON: FinderFilters = { delivery: [1, 3] };

let db: IDBDatabase;
let net: ReturnType<typeof network>;

beforeEach(async () => {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	net = network();
	world.fetchFn = net.fetchFn;
	flags.finderFailed = false;
	flags.lockState = 'unlocked';
});

afterEach(async () => {
	vi.restoreAllMocks();
	delete (document as unknown as Record<string, unknown>).visibilityState;
	held.finder = null;
	held.pack = null;
	await deleteTestDb(db);
});

/** The device after a person set the finder up; `seen` are programs they have already opened. */
async function setUpDevice(setup: FinderSetup = SET_UP, seen: number[] = [3003, 3006]) {
	const dev = await device(db, setup);
	await dev.finder.setFilters(IN_PERSON);
	await dev.pack.markOpened(seen);
	held.finder = dev.finder;
	held.pack = dev.pack;
	return dev;
}

function lock(dev: { finder: FinderStore; pack: FinderPackStore }) {
	dev.finder.relockSync('user');
	dev.pack.relockSync('user');
	flags.lockState = 'locked';
}

const row = () => document.querySelector<HTMLAnchorElement>('a.glance');
const lines = () => [
	row()?.querySelector('.glance__name')?.textContent,
	row()?.querySelector('.glance__detail')?.textContent
];
const quiet = () => new Promise((r) => setTimeout(r, 100));

describe('the SkillBridge row on Home', () => {
	it('tells a person who set up the finder what is new and how many are near their place, and opens the finder', async () => {
		await setUpDevice();
		await render(FinderHomeRow);

		await expect
			.poll(() => lines())
			.toEqual(['SkillBridge - 2 new', '5 opportunities near your selected location (Maryland)']);
		expect(row()!.getAttribute('href')).toBe('/skillbridge');
	});

	// "Near" must be true: an online program, or one offered across several states, is in the list but is not near.
	it('counts only the programs placed near the person, leaving online ones out', async () => {
		const dev = await setUpDevice();
		await dev.finder.setFilters({});
		await render(FinderHomeRow);

		// All six programs are listed; Foxtrot is online, so five are near.
		await expect
			.poll(() => lines())
			.toEqual(['SkillBridge - 2 new', '5 opportunities near your selected location (Maryland)']);
	});

	// Last week is held on the device, so a count could be shown at once: it would be last week's, and read as nothing new.
	it('says nothing until this week is checked, though last week is already held', async () => {
		const dev = await setUpDevice();
		await startedSession(dev, net);
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		world.fetchFn = async (...args) => {
			await gate;
			return net.fetchFn(...args);
		};
		await render(FinderHomeRow);

		await quiet();
		expect(row()).toBeNull();
		release();
		await expect.poll(() => lines()[0]).toBe('SkillBridge - 2 new');
	});

	it('shows no row to a person who never set the finder up, and downloads nothing', async () => {
		await setUpDevice({});
		await render(FinderHomeRow);

		await quiet();
		expect(row()).toBeNull();
		expect(net.calls).toEqual([]);
	});

	it('shows no row when the weekly news could not be checked', async () => {
		world.fetchFn = () => Promise.reject(new TypeError('offline'));
		await setUpDevice();
		await render(FinderHomeRow);

		await quiet();
		expect(row()).toBeNull();
	});

	it('shows no row when the finder could not be loaded', async () => {
		await setUpDevice();
		flags.finderFailed = true;
		await render(FinderHomeRow);

		await quiet();
		expect(row()).toBeNull();
		expect(net.calls).toEqual([]);
	});

	it('downloads nothing while the page is hidden, and counts once it is shown', async () => {
		let hidden = true;
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => (hidden ? 'hidden' : 'visible')
		});
		await setUpDevice();
		await render(FinderHomeRow);

		await quiet();
		expect(net.calls).toEqual([]);
		expect(row()).toBeNull();
		hidden = false;
		document.dispatchEvent(new Event('visibilitychange'));
		await expect.poll(() => lines()[0]).toBe('SkillBridge - 2 new');
	});
});

describe('the SkillBridge row on Home while locked', () => {
	it('asks the person to unlock and shows no number, place or program, when they have a saved record', async () => {
		const dev = await setUpDevice();
		lock(dev);
		await render(FinderHomeRow);

		await expect.poll(() => row()).not.toBeNull();
		expect(lines()).toEqual(['SkillBridge', 'Unlock to see what is new']);
		expect(row()!.textContent).not.toMatch(/\d/);
		expect(row()!.textContent).not.toContain('Maryland');
		expect(net.calls).toEqual([]);
	});

	it('shows no row to a person who never saved a finder record', async () => {
		// Nothing is saved: the finder was never opened to a save (device() saves, even an empty setup).
		const dev = { finder: createFinderStore(db), pack: createFinderPackStore(db, () => NOW) };
		await dev.finder.load();
		await dev.pack.load();
		held.finder = dev.finder;
		held.pack = dev.pack;
		const asked = vi.spyOn(dev.finder, 'hasRecord');
		lock(dev);
		await render(FinderHomeRow);

		await expect.poll(() => asked.mock.results.length).toBe(1);
		await asked.mock.results[0]!.value;
		await quiet();
		expect(row()).toBeNull();
	});

	it('turns to the locked row, with no count left on screen, when the app locks while Home is open', async () => {
		const dev = await setUpDevice();
		await render(FinderHomeRow);
		await expect.poll(() => lines()[0]).toBe('SkillBridge - 2 new');

		lock(dev);

		await expect.poll(() => lines()).toEqual(['SkillBridge', 'Unlock to see what is new']);
		expect(row()!.textContent).not.toMatch(/\d/);
	});

	it('counts again after the person unlocks', async () => {
		const dev = await setUpDevice();
		await render(FinderHomeRow);
		await expect.poll(() => lines()[0]).toBe('SkillBridge - 2 new');
		lock(dev);
		await expect.poll(() => lines()[1]).toBe('Unlock to see what is new');

		await dev.finder.load();
		await dev.pack.load();
		flags.lockState = 'unlocked';

		await expect
			.poll(() => lines())
			.toEqual(['SkillBridge - 2 new', '5 opportunities near your selected location (Maryland)']);
	});
});

describe('what the row reports to Home', () => {
	it('says whether it has a row to show, and that it has none once it is gone', async () => {
		const seen: boolean[] = [];
		await setUpDevice();
		const screen = await render(FinderHomeRow, { onpresent: (p: boolean) => seen.push(p) });
		await expect.poll(() => seen.at(-1)).toBe(true);

		await screen.unmount();

		expect(seen.at(-1)).toBe(false);
	});
});
