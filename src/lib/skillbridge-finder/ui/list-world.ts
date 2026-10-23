/**
 * A small published week for the screens' tests: six programs that differ in format, field, branch and length, an
 * optional crowd of look-alikes for paging, and a fake network that serves them and records each request. Made-up
 * values only.
 */

import { cleanListing } from '../fixtures/clean';
import type { ChangesFile, IdsFile, IndexFile, Listing, RegionFile } from '../contract/listing';
import { REGION_FILE_NAMES, dataPath, type RegionFileName } from '../contract/places';
import type { ZipsTable } from '../contract/tables';
import type { FetchFn } from '../fetch/fetch-files';
import { createFinderPackStore } from '../state/pack-store.svelte';
import { createFinderStore } from '../state/store.svelte';
import type { FinderSetup } from '../state/types';
import { createFinderSession } from './session.svelte';

export const NOW = Date.UTC(2026, 9, 23, 12);
export const PULL = '2026-10-21';
export const BYTES_PER_FILE = 1_000_000;
const LAST_PULL = '2026-10-14';
const BASELINE = '2026-10-07';

const inMaryland = (over: Partial<Listing>): Listing =>
	cleanListing({ s: 'MD', ls: ['MD'], dc: '2026-10-10', fl: PULL, ...over });

export const ALPHA = inMaryland({
	i: 3001,
	n: 'Alpha Systems',
	p: 'Network Technician',
	m: 1,
	ind: ['Computer and Mathematical'],
	b: ['Navy'],
	d: '91-120'
});
export const BRAVO = inMaryland({
	i: 3002,
	n: 'Bravo Health',
	p: 'Care Assistant',
	m: 3,
	la: 39.25,
	ind: ['Healthcare Support'],
	b: ['Army'],
	d: '1-30'
});
export const CHARLIE = inMaryland({
	i: 3003,
	n: 'Charlie Legal',
	p: 'Paralegal Internship',
	m: 1,
	ind: ['Legal'],
	b: ['Navy', 'Army'],
	d: '151-180'
});
export const DELTA = inMaryland({
	i: 3004,
	n: 'Delta Build',
	p: 'Carpentry Apprenticeship',
	m: 1,
	dc: '2026-04-01',
	fl: BASELINE,
	ind: ['Construction and Extraction'],
	b: ['Air Force'],
	d: '180+'
});
export const ECHO = inMaryland({
	i: 3005,
	n: 'Echo Records',
	p: 'Records Analyst',
	m: 3,
	dc: '2026-04-01',
	fl: BASELINE,
	ind: ['Legal'],
	b: ['Navy'],
	d: '91-120'
});
export const FOXTROT: Listing = {
	i: 3006,
	o: 306,
	n: 'Foxtrot Online',
	p: 'Remote Support Fellowship',
	m: 2,
	b: [],
	ind: ['Computer and Mathematical'],
	d: '31-60',
	dib: false,
	dc: '2026-10-13',
	fl: PULL
};

export const PROGRAMS = [ALPHA, BRAVO, CHARLIE, DELTA, ECHO, FOXTROT];

const filler = (n: number): Listing =>
	inMaryland({
		i: 4000 + n,
		n: `Filler Works ${String(n).padStart(2, '0')}`,
		p: 'Records Clerk',
		dc: '2026-04-01',
		fl: BASELINE,
		ind: ['Management'],
		b: ['Army'],
		d: '61-90'
	});

export const ZIPS: ZipsTable = { v: 1, rows: [['21046', 'MD', 39.2, -76.86]] };

const pathOf = (name: RegionFileName) => dataPath({ kind: 'region', pullDate: PULL, name });

/** A network serving the week; `fillers` adds that many look-alike Maryland programs. */
export function network(fillers = 0) {
	const crowd = Array.from({ length: fillers }, (_, n) => filler(n + 1));
	const listingsOf: Partial<Record<RegionFileName, Listing[]>> = {
		'south-atlantic': [ALPHA, BRAVO, CHARLIE, DELTA, ECHO, ...crowd],
		remote: [FOXTROT]
	};
	const index: IndexFile = {
		v: 1,
		pullDate: PULL,
		baseline: false,
		baselineDate: BASELINE,
		files: REGION_FILE_NAMES.map((name) => ({ name, count: 1, bytes: BYTES_PER_FILE }))
	};
	const ids: IdsFile = {
		v: 1,
		pullDate: PULL,
		ids: [...PROGRAMS, ...crowd].map((l): [number, string] => [l.i, l.fl]),
		aliases: []
	};
	const changes: ChangesFile = {
		v: 1,
		weeks: [
			{ pullDate: PULL, added: [3001, 3002, 3003, 3006], removed: [], newOrgs: [] },
			{ pullDate: LAST_PULL, added: [], removed: [], newOrgs: [] }
		]
	};
	const routes = new Map<string, unknown>([
		[dataPath({ kind: 'index' }), index],
		[dataPath({ kind: 'table', name: 'zips' }), ZIPS],
		[dataPath({ kind: 'ids', pullDate: PULL }), ids],
		[dataPath({ kind: 'changes', pullDate: PULL }), changes],
		...REGION_FILE_NAMES.map((name): [string, unknown] => [
			pathOf(name),
			{ v: 1, pullDate: PULL, file: name, listings: listingsOf[name] ?? [] } satisfies RegionFile
		])
	]);
	const calls: string[] = [];
	const fetchFn: FetchFn = (url) => {
		calls.push(url);
		const body = routes.get(url);
		return Promise.resolve(
			body === undefined
				? new Response('missing', { status: 404 })
				: new Response(JSON.stringify(body))
		);
	};
	return { calls, fetchFn };
}

/** The finder record and the pack on a test database, with `setup` saved; both loaded. */
export async function device(db: IDBDatabase, setup: FinderSetup = {}) {
	const finder = createFinderStore(db);
	await finder.load();
	await finder.setSetup(setup);
	const pack = createFinderPackStore(db, () => NOW);
	await pack.load();
	return { finder, pack };
}

/** A session over that device and network, already started. */
export async function startedSession(
	dev: Awaited<ReturnType<typeof device>>,
	net: ReturnType<typeof network>,
	now = NOW
) {
	const session = createFinderSession({
		finder: dev.finder,
		pack: dev.pack,
		fetchFn: net.fetchFn,
		now: () => now,
		workerPassesData: () => Promise.resolve(true)
	});
	await session.start();
	return session;
}
