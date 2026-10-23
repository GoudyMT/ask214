import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFinderSession, type FinderSession } from './session.svelte';
import { createFinderStore } from '../state/store.svelte';
import { createFinderPackStore } from '../state/pack-store.svelte';
import { bootstrapLocalKeystore } from '../../keystore/bootstrap';
import { openTestDb, deleteTestDb } from '../../db/_test-helpers';
import { withStores, reqToPromise } from '../../db/schema';
import { cleanListing } from '../fixtures/clean';
import type { ChangesFile, IdsFile, IndexFile, Listing, RegionFile } from '../contract/listing';
import { REGION_FILE_NAMES, dataPath, type RegionFileName } from '../contract/places';
import type { ZipsTable } from '../contract/tables';
import type { FetchFn } from '../fetch/fetch-files';
import type { FinderSetup } from '../state/types';

// Real Chromium (IndexedDB + SubtleCrypto): the finder session over a real pack store and finder record, with a fake
// network that serves synthetic files and records every request it gets.

const NOW = Date.UTC(2026, 9, 23, 12);
const PULL = '2026-10-21';
const LAST_PULL = '2026-10-14';
const BASELINE = '2026-10-07';
const BYTES_PER_FILE = 1_500_000;

// Columbia, MD is ZIP 21046; York, PA is about 36 miles north of it, across the state line.
const COLUMBIA = cleanListing({ i: 2001, ls: ['MD'], dc: '2026-10-10', fl: PULL });
const RICHMOND = cleanListing({
	i: 2002,
	n: 'Example Richmond Works',
	c: 'Richmond',
	s: 'VA',
	ls: ['VA'],
	z: '23219',
	la: 37.54,
	lo: -77.43,
	dc: '2026-04-01',
	fl: BASELINE
});
const YORK = cleanListing({
	i: 2101,
	n: 'Example York Partners',
	c: 'York',
	s: 'PA',
	ls: ['PA'],
	z: '17401',
	la: 39.96,
	lo: -76.73,
	dc: '2026-10-12',
	fl: PULL
});
const MULTI = cleanListing({
	i: 2201,
	n: 'Example National Logistics',
	oc: 'all',
	dc: '2026-10-05',
	fl: PULL,
	ls: ['AK', 'AL', 'MD', 'VA']
});
const REMOTE: Listing = {
	i: 2301,
	o: 302,
	n: 'Example Remote Academy',
	p: 'Software Support Fellowship',
	m: 2,
	b: [],
	ind: ['Computer and Mathematical'],
	dib: false,
	dc: '2026-10-13',
	fl: PULL
};
const SEATTLE = cleanListing({
	i: 2401,
	n: 'Example Pacific Works',
	c: 'Seattle',
	s: 'WA',
	ls: ['WA'],
	z: '98101',
	la: 47.6,
	lo: -122.33
});
const UNPLACED: Listing = {
	i: 2501,
	o: 305,
	n: 'Example Field Works',
	p: 'Construction Apprenticeship',
	m: 1,
	b: [],
	ind: ['Construction and Extraction'],
	dib: false,
	dc: '2026-10-01',
	fl: BASELINE
};

const LISTINGS_BY_FILE: Partial<Record<RegionFileName, Listing[]>> = {
	'south-atlantic': [COLUMBIA, RICHMOND],
	'middle-atlantic': [YORK],
	'multi-state': [MULTI],
	remote: [REMOTE],
	pacific: [SEATTLE],
	unknown: [UNPLACED]
};

const ZIPS: ZipsTable = {
	v: 1,
	rows: [
		['21046', 'MD', 39.2, -76.86],
		['23219', 'VA', 37.54, -77.43]
	]
};

const indexOf = (pullDate: string): IndexFile => ({
	v: 1,
	pullDate,
	baseline: false,
	baselineDate: BASELINE,
	files: REGION_FILE_NAMES.map((name) => ({ name, count: 1, bytes: BYTES_PER_FILE }))
});

// An earlier week cannot hold a listing first seen after it, so its dates are held back to its own pull.
const upTo = (pull: string, date: string) => (date > pull ? pull : date);

const regionOf = (name: RegionFileName, pullDate: string): RegionFile => ({
	v: 1,
	pullDate,
	file: name,
	listings: (LISTINGS_BY_FILE[name] ?? []).map((l) => ({
		...l,
		fl: upTo(pullDate, l.fl),
		dc: upTo(pullDate, l.dc)
	}))
});

const idsOf = (pullDate: string): IdsFile => ({
	v: 1,
	pullDate,
	ids: [
		[2001, upTo(pullDate, PULL)],
		[2002, BASELINE],
		[2101, upTo(pullDate, PULL)],
		[2201, upTo(pullDate, PULL)],
		[2301, upTo(pullDate, PULL)],
		[2401, upTo(pullDate, PULL)],
		[2501, BASELINE]
	],
	aliases: []
});

const changesOf = (pullDate: string): ChangesFile => ({
	v: 1,
	weeks: [
		{ pullDate, added: [2001, 2101, 2201, 2301], removed: [], newOrgs: [] },
		{ pullDate: pullDate === PULL ? LAST_PULL : BASELINE, added: [], removed: [], newOrgs: [] }
	]
});

const pathOf = {
	index: dataPath({ kind: 'index' }),
	zips: dataPath({ kind: 'table', name: 'zips' }),
	region: (name: RegionFileName, pull = PULL) => dataPath({ kind: 'region', pullDate: pull, name }),
	ids: (pull = PULL) => dataPath({ kind: 'ids', pullDate: pull }),
	changes: (pull = PULL) => dataPath({ kind: 'changes', pullDate: pull })
};

/** A network serving one published week; every request is recorded, in the order it was made. */
function network(pull = PULL) {
	const calls: string[] = [];
	const routes = new Map<string, unknown>([
		[pathOf.index, indexOf(pull)],
		[pathOf.zips, ZIPS],
		[pathOf.ids(pull), idsOf(pull)],
		[pathOf.changes(pull), changesOf(pull)],
		...REGION_FILE_NAMES.map((name): [string, unknown] => [
			pathOf.region(name, pull),
			regionOf(name, pull)
		])
	]);
	let down = false;
	const fetchFn: FetchFn = (url) => {
		calls.push(url);
		if (down) return Promise.reject(new TypeError('Failed to fetch'));
		const body = routes.get(url);
		return Promise.resolve(
			body === undefined
				? new Response('missing', { status: 404 })
				: new Response(JSON.stringify(body))
		);
	};
	return {
		calls,
		fetchFn,
		goDown: () => (down = true),
		regionRequests: () => calls.filter((c) => c.includes('/w/') && !/(ids|changes)\.json$/.test(c))
	};
}

/** `net` with one path answering a server error. */
const failingAt =
	(net: ReturnType<typeof network>, path: string): FetchFn =>
	(url, init) =>
		url === path ? Promise.resolve(new Response('no', { status: 500 })) : net.fetchFn(url, init);

/** `net` with one path held back until `release()`: `reached` settles when that request has been made. */
function heldAt(net: ReturnType<typeof network>, path: string) {
	let release!: () => void;
	let arrive!: () => void;
	const hold = new Promise<void>((resolve) => (release = resolve));
	const reached = new Promise<void>((resolve) => (arrive = resolve));
	const fetchFn: FetchFn = async (url, init) => {
		if (url === path) {
			arrive();
			await hold;
		}
		return net.fetchFn(url, init);
	};
	return { net: { ...net, fetchFn }, reached, release };
}

let db: IDBDatabase;
let sessions: FinderSession[] = [];

beforeEach(async () => {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
});

afterEach(async () => {
	for (const s of sessions) s.destroy();
	sessions = [];
	await deleteTestDb(db);
});

async function device(setup?: FinderSetup, loadPack = true) {
	const finder = createFinderStore(db);
	await finder.load();
	if (setup) await finder.setSetup(setup);
	const pack = createFinderPackStore(db, () => NOW);
	if (loadPack) await pack.load();
	return { finder, pack };
}

type PackRow = { id: string; rec: Uint8Array };
const packRows = () =>
	withStores(db, 'skillbridge-finder-pack', 'readonly', (tx) =>
		reqToPromise<PackRow[]>(tx.objectStore('skillbridge-finder-pack').getAll())
	);
const putPackRow = (row: PackRow) =>
	withStores(db, 'skillbridge-finder-pack', 'readwrite', (tx) => {
		tx.objectStore('skillbridge-finder-pack').put(row);
	});

type Device = Awaited<ReturnType<typeof device>>;

/** The real pack store with some of its members replaced, so a case can make one call misbehave at a chosen moment. */
function around(pack: Device['pack'], over: Partial<Device['pack']>): Device['pack'] {
	return new Proxy(pack, {
		get: (target, prop) =>
			Object.hasOwn(over, prop) ? Reflect.get(over, prop) : Reflect.get(target, prop)
	});
}

// No worker is in charge in these tests, as on a first visit; the worker answer has its own tests below.
const PASSES = () => Promise.resolve(true);

function open(
	dev: Device,
	net: ReturnType<typeof network>,
	extra: { canFetch?: () => boolean; workerPassesData?: () => Promise<boolean> } = {}
): FinderSession {
	const session = createFinderSession({
		finder: dev.finder,
		pack: dev.pack,
		fetchFn: net.fetchFn,
		now: () => NOW,
		workerPassesData: PASSES,
		...extra
	});
	sessions.push(session);
	return session;
}

const ids = (rows: { listing: Listing }[]) => rows.map((r) => r.listing.i);

describe('what the session asks the network for', () => {
	// The files fetched are the only trace of where the person is looking: with no place, nothing but the two
	// places-free files may be asked for.
	it('requests only the remote and many-state files when the person set no place', async () => {
		const net = network();
		const session = open(await device({}), net);
		await session.start();

		expect([...net.calls].sort()).toEqual(
			[
				pathOf.index,
				pathOf.region('multi-state'),
				pathOf.region('remote'),
				pathOf.ids(),
				pathOf.changes()
			].sort()
		);
		expect(ids(session.matches).sort()).toEqual([2201, 2301]);
		expect(session.status).toBe('ready');
	});

	it('requests the ZIP division and the unplaced file, and not a neighbour out of reach', async () => {
		const net = network();
		const session = open(await device({ place: { kind: 'zip', zip: '23219' }, radius: 25 }), net);
		await session.start();

		expect(net.regionRequests().sort()).toEqual(
			[
				pathOf.region('multi-state'),
				pathOf.region('remote'),
				pathOf.region('south-atlantic'),
				pathOf.region('unknown')
			].sort()
		);
		expect(net.calls).toContain(pathOf.zips);
	});

	// Richmond is about 70 miles from New Jersey, in another division; a 100 mile reach must bring that file, or the
	// nearest programs across the line are missing from the list.
	it('adds the neighbouring division when a 100 mile reach crosses a division line', async () => {
		const net = network();
		const session = open(await device({ place: { kind: 'zip', zip: '23219' }, radius: 100 }), net);
		await session.start();

		expect(net.regionRequests()).toContain(pathOf.region('middle-atlantic'));
		expect(net.regionRequests()).not.toContain(pathOf.region('pacific'));
	});

	// "Look farther" starts the visit again after widening the reach; if that lands while the first visit is still
	// downloading, the files the wider reach needs must still be fetched.
	it('fetches the files a wider reach needs when it is widened while a visit is downloading', async () => {
		const place = { kind: 'zip', zip: '23219' } as const;
		const dev = await device({ place, radius: 25 });
		const gate = heldAt(network(), pathOf.region('remote'));
		const session = open(dev, gate.net);
		const first = session.start();
		await gate.reached;
		expect(gate.net.regionRequests()).not.toContain(pathOf.region('middle-atlantic'));

		await dev.finder.setSetup({ place, radius: 100 });
		const second = session.start();
		gate.release();
		await Promise.all([first, second]);

		expect(gate.net.regionRequests()).toContain(pathOf.region('middle-atlantic'));
		expect(await dev.pack.readRegion('middle-atlantic')).toBeDefined();
	});

	// The person locked after widening: the visit owed to the wider reach is not run on a locked pack.
	it('does not start the owed visit again once the pack has relocked', async () => {
		const place = { kind: 'zip', zip: '23219' } as const;
		const dev = await device({ place, radius: 25 });
		const gate = heldAt(network(), pathOf.region('remote'));
		const session = open(dev, gate.net);
		const first = session.start();
		await gate.reached;
		await dev.finder.setSetup({ place, radius: 100 });
		const second = session.start();

		dev.pack.relockSync('user');
		gate.release();
		await Promise.all([first, second]);

		expect(gate.net.calls.filter((c) => c === pathOf.index)).toHaveLength(1);
		expect(session.status).toBe('loading');
	});

	// A start that arrives after the relock, while the cut-short visit is still winding down, must not queue a visit of
	// its own: that would open the pack the relock closed, with nobody looking.
	it.each(['user', 'hygiene'] as const)(
		'queues no visit from a start that follows a %s relock mid-visit',
		async (reason) => {
			const place = { kind: 'zip', zip: '23219' } as const;
			const dev = await device({ place, radius: 25 });
			const gate = heldAt(network(), pathOf.region('remote'));
			const session = open(dev, gate.net);
			const first = session.start();
			await gate.reached;

			dev.pack.relockSync(reason);
			await dev.finder.setSetup({ place, radius: 100 });
			const second = session.start();
			gate.release();
			await Promise.all([first, second]);

			expect(gate.net.calls.filter((c) => c === pathOf.index)).toHaveLength(1);
			expect(dev.pack.ready).toBe(false);
			expect(session.listings).toEqual([]);
		}
	);

	// An Unlock opened the pack again before the cut-short visit wound down: that visit shows nothing, so the start the
	// Unlock makes needs one of its own.
	it.each(['user', 'idle', 'peer'] as const)(
		'runs a fresh visit for a start after a %s relock and an Unlock mid-visit',
		async (reason) => {
			const place = { kind: 'zip', zip: '23219' } as const;
			const dev = await device({ place, radius: 25 });
			const gate = heldAt(network(), pathOf.region('remote'));
			const session = open(dev, gate.net);
			const first = session.start();
			await gate.reached;

			dev.pack.relockSync(reason);
			await dev.pack.load();
			const second = session.start();
			gate.release();
			await Promise.all([first, second]);

			expect(session.status).toBe('ready');
			expect(ids(session.matches)).toContain(RICHMOND.i);
		}
	);

	// A second tap on Retry, or a second screen asking, while a visit runs is the same visit, not another download.
	it('runs one visit for two starts when the setup did not move', async () => {
		const gate = heldAt(network(), pathOf.region('remote'));
		const session = open(await device({}), gate.net);
		const first = session.start();
		await gate.reached;
		const second = session.start();
		gate.release();
		await Promise.all([first, second]);

		expect(gate.net.calls.filter((c) => c === pathOf.index)).toHaveLength(1);
	});

	it('lists the nearest programs first with their distance, across a state line', async () => {
		const session = open(
			await device({ place: { kind: 'zip', zip: '21046' }, radius: 100 }),
			network()
		);
		await session.start();

		expect(ids(session.matches).slice(0, 2)).toEqual([2001, 2101]);
		expect(session.matches[0]?.miles).toBeLessThan(5);
		expect(session.matches[1]?.miles).toBeGreaterThan(30);
	});

	it('keeps the ZIP table once fetched, so a second visit does not ask for it again', async () => {
		const dev = await device({ place: { kind: 'zip', zip: '21046' }, radius: 25 });
		await open(dev, network()).start();
		const again = network();
		await open(dev, again).start();

		expect(again.calls).not.toContain(pathOf.zips);
	});

	it('requests nothing at all when the guard says the network is not to be used', async () => {
		const net = network();
		const session = open(await device({}), net, { canFetch: () => false });
		await session.start();

		expect(net.calls).toHaveLength(0);
		expect(session.status).toBe('offline');
	});

	// An older worker keeps a copy of every file it serves, which would leave on disk where the person is looking.
	it('requests nothing when the worker in charge would keep a copy, and says it could not download', async () => {
		const dev = await device({});
		await open(dev, network()).start();
		const net = network(LAST_PULL);
		const session = open(dev, net, { workerPassesData: () => Promise.resolve(false) });
		await session.start();

		expect(net.calls).toHaveLength(0);
		expect(session.status).toBe('failed');
		expect(session.downloadBlocked).toBe(true);
		// What is held is still on screen.
		expect(ids(session.matches).sort()).toEqual([2201, 2301]);
	});

	it('asks the worker once per start, however many files are fetched', async () => {
		let asked = 0;
		const session = open(await device({}), network(), {
			workerPassesData: () => {
				asked++;
				return Promise.resolve(true);
			}
		});
		await session.start();

		expect(asked).toBe(1);
	});

	// A worker that cannot be asked may be an older one that keeps a copy: no answer is a no, not a yes.
	it('requests nothing when asking the worker fails', async () => {
		const net = network();
		const session = open(await device({}), net, {
			workerPassesData: () => Promise.reject(new Error('no worker'))
		});
		await session.start();

		expect(net.calls).toHaveLength(0);
		expect(session.status).toBe('failed');
		expect(session.downloadBlocked).toBe(true);
	});

	// A worker can take charge between two visits: the answer of the first must not stand for the second.
	it('asks the worker again on each start, and obeys the newer answer', async () => {
		const answers = [true, false];
		const session = open(await device({}), network(), {
			workerPassesData: () => Promise.resolve(answers.shift() ?? false)
		});
		await session.start();
		expect(session.downloadBlocked).toBe(false);
		expect(answers).toEqual([false]);

		await session.start();

		expect(answers).toEqual([]);
		expect(session.status).toBe('failed');
		expect(session.downloadBlocked).toBe(true);
	});

	it('asks the worker nothing when the guard already refuses', async () => {
		let asked = 0;
		const session = open(await device({}), network(), {
			canFetch: () => false,
			workerPassesData: () => {
				asked++;
				return Promise.resolve(true);
			}
		});
		await session.start();

		expect(asked).toBe(0);
		expect(session.downloadBlocked).toBe(false);
	});

	it('requests nothing for the ZIP table either when the guard refuses', async () => {
		const net = network();
		const session = open(await device({ place: { kind: 'zip', zip: '21046' } }), net, {
			canFetch: () => false
		});
		await expect(session.ensureZips()).resolves.toBeUndefined();

		expect(net.calls).toHaveLength(0);
	});

	it('shows a state only the programs in that state, with online and unplaced ones after them', async () => {
		const net = network();
		const session = open(await device({ place: { kind: 'state', state: 'VA' } }), net);
		await session.start();

		// No point to measure from, so newest first with the unplaced last. The Maryland program from the same
		// division is left out; the many-state program names VA.
		expect(ids(session.matches)).toEqual([2301, 2201, 2002, 2501]);
	});
});

describe('the held week', () => {
	it('opens on the held week at once and says offline when the network fails', async () => {
		const dev = await device({});
		await open(dev, network()).start();

		const down = network();
		down.goDown();
		const session = open(dev, down);
		await session.start();

		expect(session.status).toBe('offline');
		expect(session.pullDate).toBe(PULL);
		expect(ids(session.matches).sort()).toEqual([2201, 2301]);
	});

	// A server that serves last week's index would otherwise replace this week's listings with older ones.
	it('changes nothing and downloads no file when the index is older than the held week', async () => {
		const dev = await device({});
		await open(dev, network()).start();

		const old = network(LAST_PULL);
		const session = open(dev, old);
		await session.start();

		expect(old.calls).toEqual([pathOf.index]);
		expect(dev.pack.pullDate).toBe(PULL);
		expect(session.pullDate).toBe(PULL);
		expect(ids(session.matches).sort()).toEqual([2201, 2301]);
	});

	it('swaps in a newer week with its files all at once', async () => {
		const dev = await device({});
		await open(dev, network(LAST_PULL)).start();
		expect(dev.pack.pullDate).toBe(LAST_PULL);

		const session = open(dev, network(PULL));
		await session.start();

		expect(dev.pack.pullDate).toBe(PULL);
		expect(session.pullDate).toBe(PULL);
		expect(ids(session.matches).sort()).toEqual([2201, 2301]);
	});

	it('fetches only the files the held week lacks when the place changes within a week', async () => {
		const dev = await device({});
		await open(dev, network()).start();
		await dev.finder.setSetup({ place: { kind: 'state', state: 'VA' } });

		const net = network();
		await open(dev, net).start();

		expect(net.regionRequests().sort()).toEqual(
			[pathOf.region('south-atlantic'), pathOf.region('unknown')].sort()
		);
		expect(net.calls).not.toContain(pathOf.ids());
	});

	it('keeps the held week and says offline when one needed file cannot be read', async () => {
		const dev = await device({});
		await open(dev, network(LAST_PULL)).start();
		const net = network(PULL);
		const partial: typeof net.fetchFn = (url, init) =>
			url === pathOf.region('remote')
				? Promise.resolve(new Response('no', { status: 500 }))
				: net.fetchFn(url, init);
		const session = createFinderSession({
			finder: dev.finder,
			pack: dev.pack,
			fetchFn: partial,
			now: () => NOW,
			workerPassesData: PASSES
		});
		sessions.push(session);
		await session.start();

		expect(dev.pack.pullDate).toBe(LAST_PULL);
		expect(session.status).toBe('offline');
	});

	// A newer week without its changes file would replace the held week's, and every New mark would read as "not new".
	it.each([
		['ids', pathOf.ids()],
		['changes', pathOf.changes()]
	])(
		'keeps the held week and says offline when the newer week has no %s file',
		async (_name, path) => {
			const dev = await device({});
			await open(dev, network(LAST_PULL)).start();
			const net = network(PULL);
			const session = open(dev, { ...net, fetchFn: failingAt(net, path) });
			await session.start();

			expect(dev.pack.pullDate).toBe(LAST_PULL);
			expect(session.pullDate).toBe(LAST_PULL);
			expect(session.status).toBe('offline');
			expect((await dev.pack.readChanges())?.weeks[0]?.pullDate).toBe(LAST_PULL);
		}
	);

	// Nothing held means nothing to lose: the list from a first download is worth showing without its New marks, and the
	// next visit to the same week asks for what is missing.
	it('shows a first download whose changes file is missing, and asks for it on the next visit', async () => {
		const dev = await device({});
		const net = network(PULL);
		const first = open(dev, { ...net, fetchFn: failingAt(net, pathOf.changes()) });
		await first.start();

		expect(first.status).toBe('ready');
		expect(ids(first.matches).sort()).toEqual([2201, 2301]);

		const again = network(PULL);
		await open(dev, again).start();
		expect(again.calls).toContain(pathOf.changes());
	});
});

describe('New', () => {
	it('marks the listings isNew says, and stops when one is opened, saved or compared', async () => {
		const dev = await device({ place: { kind: 'zip', zip: '21046' }, radius: 100 });
		const session = open(dev, network());
		await session.start();

		// Columbia and York first listed this week and created within 30 days; Richmond is at the baseline date.
		expect(session.isNewId(2001)).toBe(true);
		expect(session.isNewId(2101)).toBe(true);
		expect(session.isNewId(2002)).toBe(false);
		expect(session.isNewId(999)).toBe(false);

		await session.markOpened(2001);
		expect(session.isNewId(2001)).toBe(false);

		await dev.finder.save(YORK, '2026-10-23');
		expect(session.isNewId(2101)).toBe(false);

		await dev.finder.addCompare(2201);
		expect(session.isNewId(2201)).toBe(false);
	});

	it('marks every New listing seen and moves the last-seen week forward', async () => {
		const dev = await device({});
		const session = open(dev, network());
		await session.start();
		expect(session.isNewId(2201)).toBe(true);
		expect(session.isNewId(2301)).toBe(true);

		await session.markAllSeen();

		expect(session.isNewId(2201)).toBe(false);
		expect(session.isNewId(2301)).toBe(false);
		expect(dev.pack.seen.has(2201)).toBe(true);
		expect(dev.pack.lastSeenPull).toBe(PULL);
	});
});

describe('how old the listings are', () => {
	it('counts whole days from the pull date to the device clock', async () => {
		const dev = await device({});
		await open(dev, network()).start();
		const late = createFinderSession({
			finder: dev.finder,
			pack: dev.pack,
			fetchFn: network().fetchFn,
			now: () => Date.UTC(2026, 10, 7, 3),
			workerPassesData: PASSES,
			canFetch: () => false
		});
		sessions.push(late);
		await late.start();

		expect(late.staleDays).toBe(17);
	});

	it('counts the weekly updates missed since the person last saw the list', async () => {
		const dev = await device({});
		await dev.pack.advanceLastSeen('2026-09-09');
		const session = open(dev, network());
		await session.start();

		// 2026-09-09 to 2026-10-21 is 42 days: six weekly updates.
		expect(session.missedWeeks).toBe(6);
		expect(dev.pack.lastSeenPull).toBe(PULL);
	});

	it('counts none when the person has never seen a list', async () => {
		const session = open(await device({}), network());
		await session.start();

		expect(session.missedWeeks).toBe(0);
	});
});

describe('search', () => {
	it('finds by company, with a typo, and by place, among the loaded listings', async () => {
		const session = open(
			await device({ place: { kind: 'zip', zip: '21046' }, radius: 100 }),
			network()
		);
		await session.start();

		session.query = 'services';
		expect(ids(session.results)).toEqual([2001]);
		session.query = 'Yorkk Partners';
		expect(ids(session.results)).toEqual([2101]);
		session.query = '';
		expect(ids(session.results)).toEqual(ids(session.matches));
	});

	it('does not search what the filters leave out', async () => {
		const dev = await device({ place: { kind: 'zip', zip: '21046' }, radius: 100 });
		const session = open(dev, network());
		await session.start();
		await dev.finder.setFilters({ delivery: [3] });

		session.query = 'example';
		expect(session.results).toEqual([]);
	});

	it('offers the whole country only with no place, sized by the index, and fetches after the ask', async () => {
		const net = network();
		const session = open(await device({}), net);
		await session.start();

		// Nine divisions and the unplaced file are not held; the many-state and remote files are.
		expect(session.needsSearchAll).toBe(true);
		expect(session.searchAllBytes).toBe(10 * BYTES_PER_FILE);
		expect(net.regionRequests()).toHaveLength(2);

		await session.searchAll();

		expect(net.regionRequests()).toHaveLength(12);
		expect(session.needsSearchAll).toBe(false);
		session.query = 'seattle';
		expect(ids(session.results)).toEqual([2401]);
	});

	// A person who set a place and is offline holds fewer files than the place needs; the whole-country offer is for
	// someone with no place, and would be a wrong thing to put in front of them.
	it('offers no whole-country search once a place is set, even when its files are not held yet', async () => {
		const dev = await device({});
		await open(dev, network()).start();
		await dev.finder.setSetup({ place: { kind: 'state', state: 'VA' } });
		const down = network();
		down.goDown();
		const session = open(dev, down);
		await session.start();

		expect(session.status).toBe('offline');
		expect(session.needsSearchAll).toBe(false);
		expect(session.searchAllBytes).toBe(0);
	});
});

describe('rows the pack cannot read', () => {
	// After a restore, rows sealed under an older key stay behind and fail to open. The session clears them and
	// downloads again; it never shows what it could not read.
	it('clears an unreadable pack, reads it again and fetches fresh data', async () => {
		const dev = await device({}, false);
		await putPackRow({ id: 'index', rec: new Uint8Array(32) });
		const net = network();
		const session = open(dev, net);
		await session.start();

		expect(session.status).toBe('ready');
		expect(session.pullDate).toBe(PULL);
		expect(ids(session.matches).sort()).toEqual([2201, 2301]);
		const index = (await packRows()).find((row) => row.id === 'index');
		expect(index?.rec.length).toBeGreaterThan(32);
	});

	it('does the same when the caller already tried to open the pack and it failed', async () => {
		const dev = await device({}, false);
		await putPackRow({ id: 'index', rec: new Uint8Array(32) });
		await expect(dev.pack.load()).rejects.toThrow();
		expect(dev.pack.failed).toBe(true);
		const session = open(dev, network());
		await session.start();

		expect(session.status).toBe('ready');
		expect(dev.pack.failed).toBe(false);
	});

	// The earlier failed open may have been fixed since, by another tab that cleared the rows and downloaded: clearing
	// again would throw away the week it just stored.
	it('reads a pack that a peer tab has recovered since its open failed, and does not clear it', async () => {
		const dev = await device({}, false);
		await putPackRow({ id: 'index', rec: new Uint8Array(32) });
		await expect(dev.pack.load()).rejects.toThrow();
		expect(dev.pack.failed).toBe(true);
		const peer = createFinderPackStore(db, () => NOW);
		await open({ finder: dev.finder, pack: peer }, network()).start();
		expect(peer.pullDate).toBe(PULL);

		const net = network();
		const session = open(dev, net);
		await session.start();

		expect(net.calls).toEqual([pathOf.index]);
		expect(session.pullDate).toBe(PULL);
		expect(ids(session.matches).sort()).toEqual([2201, 2301]);
	});

	// A week another tab moved on is not damage: the files on disk are good, and clearing them would download the
	// week again for nothing.
	it('answers a week another tab moved on by reading again, not by clearing', async () => {
		const seed = await device({});
		await open(seed, network(LAST_PULL)).start();
		// This tab opened on last week and has read no file yet; another tab then moves the disk to this week.
		const tab = createFinderPackStore(db, () => NOW);
		await tab.load();
		expect(tab.pullDate).toBe(LAST_PULL);
		const peer = createFinderPackStore(db, () => NOW);
		await peer.load();
		await open({ finder: seed.finder, pack: peer }, network(PULL)).start();
		expect(peer.pullDate).toBe(PULL);

		const net = network(PULL);
		const session = open({ finder: seed.finder, pack: tab }, net);
		await session.start();

		expect(net.calls).toEqual([pathOf.index]);
		expect(session.pullDate).toBe(PULL);
		expect(ids(session.matches).sort()).toEqual([2201, 2301]);
	});
});

describe('Lock', () => {
	// Listings, the search index and the results are decrypted copies: a lock that leaves any of them behind keeps
	// what the person searched readable on a locked device.
	it('leaves no listing, result or index in the session when the pack relocks', async () => {
		const dev = await device({});
		const session = open(dev, network());
		await session.start();
		session.query = 'remote';
		expect(session.results).toHaveLength(1);
		expect(session.indexHeld).toBe(true);

		dev.pack.relockSync('user');

		expect(session.listings).toEqual([]);
		expect(session.matches).toEqual([]);
		expect(session.results).toEqual([]);
		expect(session.indexHeld).toBe(false);
		expect(session.query).toBe('');
		expect(session.pullDate).toBeUndefined();
	});

	it('leaves no ZIP table in the session when the pack relocks', async () => {
		const dev = await device({ place: { kind: 'zip', zip: '21046' }, radius: 25 });
		const session = open(dev, network());
		await session.start();
		expect(session.zips).toBeDefined();

		dev.pack.relockSync('user');

		expect(session.zips).toBeUndefined();
	});

	// A download that was still running when the person locked must not put its week into a pack they unlock later.
	it('keeps a download that finishes after a lock and an unlock out of the pack', async () => {
		const dev = await device({});
		await open(dev, network(LAST_PULL)).start();
		const gate = heldAt(network(PULL), pathOf.region('remote'));
		const session = open(dev, gate.net);
		const visit = session.start();
		await gate.reached;

		dev.pack.relockSync('user');
		await dev.pack.load();
		gate.release();
		await visit;

		expect(dev.pack.pullDate).toBe(LAST_PULL);
	});

	// The ZIP table is fetched on demand; one that arrives after a lock is not kept, nor handed to the caller.
	it('keeps a ZIP table that arrives after a lock out of the session', async () => {
		const dev = await device({ place: { kind: 'zip', zip: '21046' }, radius: 25 });
		const gate = heldAt(network(), pathOf.zips);
		const session = open(dev, gate.net);
		const asked = session.ensureZips();
		await gate.reached;

		dev.pack.relockSync('user');
		gate.release();

		await expect(asked).resolves.toBeUndefined();
		expect(session.zips).toBeUndefined();
	});

	// A full device refuses to keep the week, but it did download: saying it "couldn't be downloaded" would be untrue,
	// so the week is shown for this visit and asked for again on the next.
	it('shows a downloaded week the device could not keep, for this visit', async () => {
		const dev = await device({ place: { kind: 'zip', zip: '21046' }, radius: 100 });
		const pack = around(dev.pack, {
			swap: () => Promise.reject(new DOMException('full', 'QuotaExceededError'))
		});
		const session = open({ finder: dev.finder, pack }, network());
		await session.start();

		expect(session.status).toBe('ready');
		expect(ids(session.matches)).toContain(COLUMBIA.i);
		expect(await dev.pack.readRegion('south-atlantic')).toBeUndefined();
	});

	// The usual weekly update on a full device: last week is on disk, this week cannot be kept. The list shows this
	// week, so its date and New marks must be this week's, not last week's.
	it('dates a week it could not keep by that week, not by the older one on disk', async () => {
		const place = { kind: 'zip', zip: '21046' } as const;
		const dev = await device({ place, radius: 100 });
		await open(dev, network(LAST_PULL)).start();
		const pack = around(dev.pack, {
			swap: () => Promise.reject(new DOMException('full', 'QuotaExceededError'))
		});
		const net = network();
		const session = open({ finder: dev.finder, pack }, net);
		await session.start();

		expect(session.status).toBe('ready');
		expect(session.pullDate).toBe(PULL);
		expect(dev.pack.pullDate).toBe(LAST_PULL);

		// The next visit, offline, has only the disk: it is dated by the disk's week.
		net.goDown();
		await session.start();
		expect(session.pullDate).toBe(LAST_PULL);
	});

	// The week on screen is only in memory; a later download that the device does keep must not replace the whole older
	// week on disk with a few files of the new one, which an offline visit would then show as a hole.
	it('keeps the older week on disk whole when a later search follows a week shown from memory', async () => {
		const dev = await device({});
		await open(dev, network(LAST_PULL)).start();
		let full = true;
		const pack = around(dev.pack, {
			swap: (input) =>
				full ? Promise.reject(new DOMException('full', 'QuotaExceededError')) : dev.pack.swap(input)
		});
		const session = open({ finder: dev.finder, pack }, network());
		await session.start();

		full = false;
		await session.searchAll();

		expect(dev.pack.pullDate).toBe(LAST_PULL);
		expect(await dev.pack.readRegion('remote')).toBeDefined();
		expect(await dev.pack.readIds()).toBeDefined();
	});

	// A Lock clears a week shown from memory like any other, and the next visit starts from the disk again.
	it('drops a week shown from memory on a Lock, and dates the next visit by the disk', async () => {
		const place = { kind: 'zip', zip: '21046' } as const;
		const dev = await device({ place, radius: 100 });
		await open(dev, network(LAST_PULL)).start();
		const pack = around(dev.pack, {
			swap: () => Promise.reject(new DOMException('full', 'QuotaExceededError'))
		});
		const net = network();
		const session = open({ finder: dev.finder, pack }, net);
		await session.start();
		expect(session.pullDate).toBe(PULL);

		dev.pack.relockSync('user');
		expect(session.pullDate).toBeUndefined();
		expect(session.listings).toEqual([]);

		await dev.pack.load();
		net.goDown();
		await session.start();
		expect(session.pullDate).toBe(LAST_PULL);
	});

	// Only a full device is shown from memory; any other refusal (a week older than the one on disk, bad files) is the
	// pack store saying no, and the list must not show what it refused.
	it('shows nothing new when the pack refuses the week for another reason', async () => {
		const dev = await device({ place: { kind: 'zip', zip: '21046' }, radius: 100 });
		const pack = around(dev.pack, {
			swap: () => Promise.reject(new Error('E_FINDER_PACK_ROLLBACK'))
		});
		const session = open({ finder: dev.finder, pack }, network());
		await session.start();

		expect(session.status).toBe('offline');
		expect(session.listings).toEqual([]);
	});

	// "Search every region" after a visit the device could not keep: the files it adds join the shown week rather than
	// replacing the list with what the disk holds.
	it('adds the files a later search keeps to the week shown from memory', async () => {
		const dev = await device({});
		let full = true;
		const pack = around(dev.pack, {
			swap: (input) =>
				full ? Promise.reject(new DOMException('full', 'QuotaExceededError')) : dev.pack.swap(input)
		});
		const session = open({ finder: dev.finder, pack }, network());
		await session.start();
		const shown = ids(session.matches);
		expect(shown).toContain(REMOTE.i);

		full = false;
		await session.searchAll();

		expect(ids(session.matches)).toEqual(expect.arrayContaining([...shown, SEATTLE.i]));
	});

	// A read that finishes after the person locked must not put its listings back on a locked device.
	it('puts nothing back when a lock lands while the held files are being read', async () => {
		const dev = await device({});
		await open(dev, network()).start();
		const pack = around(dev.pack, {
			readRegion: async (name) => {
				const file = await dev.pack.readRegion(name);
				dev.pack.relockSync('user');
				return file;
			}
		});
		const session = open({ finder: dev.finder, pack }, network());
		await session.start();

		expect(session.listings).toEqual([]);
		expect(session.matches).toEqual([]);
		expect(dev.pack.locked).toBe(true);
	});

	// Another tab moving the week on is answered by reading again; a lock that landed in between is not a reason to open
	// the pack, which only the person's own Unlock does.
	it('does not open a locked pack again to answer a week another tab moved on', async () => {
		const dev = await device({});
		await open(dev, network()).start();
		let loads = 0;
		const pack = around(dev.pack, {
			readRegion: () => {
				dev.pack.relockSync('user');
				return Promise.reject(new Error('E_FINDER_PACK_STALE'));
			},
			load: () => {
				loads++;
				return dev.pack.load();
			}
		});
		const net = network();
		const session = open({ finder: dev.finder, pack }, net);
		await session.start();

		expect(loads).toBe(0);
		expect(dev.pack.locked).toBe(true);
		expect(dev.pack.ready).toBe(false);
		expect(session.listings).toEqual([]);
		expect(net.calls).toHaveLength(0);
	});

	// The person locks while the visit is still opening the pack: that open ends early with nothing held, and the visit
	// must not go on to download for a pack that is shut.
	it('requests nothing when a lock lands while the visit is opening the pack', async () => {
		const dev = await device({}, false);
		const pack = around(dev.pack, {
			load: async () => {
				const opening = dev.pack.load();
				dev.pack.relockSync('user');
				await opening;
			}
		});
		const net = network();
		const session = open({ finder: dev.finder, pack }, net);
		await session.start();

		expect(net.calls).toHaveLength(0);
		expect(session.status).toBe('failed');
		expect(dev.pack.ready).toBe(false);
		expect(dev.pack.locked).toBe(true);
	});

	it('requests nothing when a lock lands while an unreadable pack is cleared and opened again', async () => {
		const dev = await device({}, false);
		await putPackRow({ id: 'index', rec: new Uint8Array(32) });
		await expect(dev.pack.load()).rejects.toThrow();
		const pack = around(dev.pack, {
			load: async () => {
				const opening = dev.pack.load();
				dev.pack.relockSync('user');
				await opening;
			}
		});
		const net = network();
		const session = open({ finder: dev.finder, pack }, net);
		await session.start();

		expect(net.calls).toHaveLength(0);
		expect(session.status).toBe('failed');
		expect(dev.pack.locked).toBe(true);
	});

	// The clear itself waits on the keystore and the pack lock, so a Lock, or the page going away, can land inside it. The
	// read after the clear would then open the pack the person (or the page) just closed.
	it.each(['user', 'hygiene'] as const)(
		'opens nothing when a %s relock lands while an unreadable pack is being cleared',
		async (reason) => {
			const dev = await device({}, false);
			await putPackRow({ id: 'index', rec: new Uint8Array(32) });
			await expect(dev.pack.load()).rejects.toThrow();
			let loads = 0;
			const pack = around(dev.pack, {
				load: async () => {
					loads++;
					await dev.pack.load();
				},
				drop: async () => {
					const clearing = dev.pack.drop();
					dev.pack.relockSync(reason);
					await clearing;
				}
			});
			const net = network();
			const session = open({ finder: dev.finder, pack }, net);
			await session.start();

			// The first read is the one that finds the rows unreadable; none may follow the clear.
			expect(loads).toBe(1);
			expect(dev.pack.ready).toBe(false);
			expect(session.listings).toEqual([]);
			expect(net.calls).toHaveLength(0);
		}
	);

	// The read after the clear can be cut short by a Lock too: it then returns with the pack shut.
	it('requests nothing when a lock lands while the cleared pack is read again', async () => {
		const dev = await device({}, false);
		await putPackRow({ id: 'index', rec: new Uint8Array(32) });
		await expect(dev.pack.load()).rejects.toThrow();
		let loads = 0;
		const pack = around(dev.pack, {
			load: async () => {
				loads++;
				const opening = dev.pack.load();
				if (loads === 2) dev.pack.relockSync('user');
				await opening;
			}
		});
		const net = network();
		const session = open({ finder: dev.finder, pack }, net);
		await session.start();

		expect(loads).toBe(2);
		expect(net.calls).toHaveLength(0);
		expect(dev.pack.locked).toBe(true);
		expect(session.listings).toEqual([]);
	});

	it('fails closed when the pack is not open, and requests nothing', async () => {
		const dev = await device({});
		dev.pack.relockSync('user');
		const net = network();
		const session = open(dev, net);
		await session.start();

		expect(session.status).toBe('failed');
		expect(net.calls).toHaveLength(0);
	});
});
