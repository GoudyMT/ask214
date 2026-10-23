import { describe, it, expect } from 'vitest';
import { cleanListing } from '../fixtures/clean';
import type { IndexFile, RegionFile } from '../contract/listing';
import { DIVISIONS, dataPath, type RegionFileName, type TableFileName } from '../contract/places';
import {
	fetchDataFile,
	fetchIndex,
	fetchRegionFiles,
	fetchWeekFile,
	type FetchFn
} from './fetch-files';

const PULL = '2026-10-21';
const EXPECTED_INIT = {
	cache: 'no-store',
	credentials: 'omit',
	redirect: 'error',
	referrerPolicy: 'no-referrer',
	mode: 'same-origin'
};

/** Roomy enough for every fixture file; the tests of the size check declare their own. */
const DECLARED_BYTES = 100_000;

const indexOf = (
	names: readonly string[],
	pullDate = PULL,
	bytes: number = DECLARED_BYTES
): IndexFile => ({
	v: 1,
	pullDate,
	baseline: false,
	baselineDate: '2026-10-14',
	files: names.map((name) => ({ name: name as RegionFileName, count: 1, bytes }))
});

const regionOf = (file: string, over: Record<string, unknown> = {}): RegionFile =>
	({ v: 1, pullDate: PULL, file, listings: [cleanListing()], ...over }) as RegionFile;

type Reply = string | Uint8Array<ArrayBuffer> | Response;

/** A fetch that answers from a table of path -> body and records every call it gets. */
function serve(routes: Record<string, Reply>) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchFn: FetchFn = (url, init) => {
		calls.push({ url, init });
		const reply = routes[url];
		if (reply === undefined) return Promise.resolve(new Response('missing', { status: 404 }));
		if (reply instanceof Response) return Promise.resolve(reply);
		return Promise.resolve(new Response(typeof reply === 'string' ? reply : new Blob([reply])));
	};
	return { fetchFn, calls };
}

const regionPath = (name: string, pullDate = PULL) =>
	dataPath({ kind: 'region', pullDate, name: name as RegionFileName });
const json = (value: unknown) => JSON.stringify(value);
const INDEX_PATH = dataPath({ kind: 'index' });

describe('request shape', () => {
	// The server must learn nothing but which fixed file was asked for: no cookie, header, query or referrer.
	it('sends the dataPath URL and exactly the five privacy options, for every kind of file', async () => {
		const { fetchFn, calls } = serve({
			[INDEX_PATH]: json(indexOf(['pacific'])),
			[regionPath('pacific')]: json(regionOf('pacific')),
			[dataPath({ kind: 'table', name: 'zips' })]: json({ v: 1, rows: [] })
		});
		const index = await fetchIndex(fetchFn);
		await fetchRegionFiles(index, ['pacific'], fetchFn);
		await fetchDataFile({ kind: 'table', name: 'zips' }, fetchFn);

		expect(calls.map((c) => c.url)).toEqual([
			INDEX_PATH,
			regionPath('pacific'),
			dataPath({ kind: 'table', name: 'zips' })
		]);
		for (const call of calls) {
			expect(call.init).toStrictEqual(EXPECTED_INIT);
			expect(call.url).not.toContain('?');
		}
	});

	// A value that is not on the fixed lists must stop at dataPath, before anything leaves the device.
	it('refuses a name off the fixed lists before any request is made', async () => {
		const hostile = '../index' as RegionFileName;
		const { fetchFn, calls } = serve({ [regionPath('pacific')]: json(regionOf('pacific')) });
		await expect(
			fetchRegionFiles(indexOf(['pacific', hostile]), ['pacific', hostile], fetchFn)
		).rejects.toThrow('E_SBF_BAD_PATH');
		await expect(
			fetchDataFile({ kind: 'table', name: '../zips' as TableFileName }, fetchFn)
		).rejects.toThrow('E_SBF_BAD_PATH');
		expect(calls).toEqual([]);
	});
});

describe('fetchIndex', () => {
	it('returns an index that passes the contract', async () => {
		const index = indexOf(['pacific', 'remote']);
		const { fetchFn } = serve({ [INDEX_PATH]: json(index) });
		expect(await fetchIndex(fetchFn)).toEqual(index);
	});

	// An index naming a file off the fixed list is refused whole, so nothing it names is ever requested.
	it('refuses an index that names a file off the fixed list, and fetches nothing else', async () => {
		const { fetchFn, calls } = serve({
			[INDEX_PATH]: json(indexOf(['pacific', 'evil'])),
			[regionPath('pacific')]: json(regionOf('pacific'))
		});
		await expect(fetchIndex(fetchFn)).rejects.toThrow('E_SBF_INVALID');
		expect(calls).toHaveLength(1);
	});

	// An index dated far ahead would pin the person to a pull no later week could replace.
	it('refuses an index dated more than 7 UTC days after the device day, and keeps one exactly 7 ahead', async () => {
		const afternoon = Date.UTC(2026, 9, 22, 15, 30);
		const ahead = (pullDate: string) =>
			fetchIndex(
				serve({ [INDEX_PATH]: json(indexOf(['pacific'], pullDate)) }).fetchFn,
				() => afternoon
			);
		expect((await ahead('2026-10-29')).pullDate).toBe('2026-10-29');
		await expect(ahead('2026-10-30')).rejects.toThrow('E_SBF_INVALID');
		await expect(ahead('9999-12-31')).rejects.toThrow('E_SBF_INVALID');
	});

	it.each([
		['a non-OK status', new Response('x', { status: 500 }), 'E_SBF_HTTP'],
		['a body that is not UTF-8', new Uint8Array([0xff, 0xfe, 0x7b]), 'E_SBF_BAD_ENCODING'],
		['a body that is not JSON', '{"v":1,', 'E_SBF_BAD_JSON'],
		[
			'a body past the size cap',
			new Response('{}', { headers: { 'content-length': String(1024 * 1024 * 1024) } }),
			'E_SBF_TOO_LARGE'
		]
	] as [string, Reply, string][])('throws a static code for %s', async (_name, reply, code) => {
		const { fetchFn } = serve({ [INDEX_PATH]: reply });
		await expect(fetchIndex(fetchFn)).rejects.toThrow(code);
	});
});

describe('fetchRegionFiles', () => {
	it('returns a valid file for the requested pull date', async () => {
		const file = regionOf('pacific');
		const { fetchFn } = serve({ [regionPath('pacific')]: json(file) });
		const result = await fetchRegionFiles(indexOf(['pacific']), ['pacific'], fetchFn);
		expect([...result.files.keys()]).toEqual(['pacific']);
		expect(result.files.get('pacific')).toEqual(file);
		expect(result.dropped).toEqual([]);
	});

	// A listing the contract refuses, a stale week, or a file swapped for another region must never be shown.
	it('drops a file that fails the contract, one from another pull date, and one that names another file, but keeps the good one', async () => {
		const index = indexOf(['pacific', 'mountain', 'new-england', 'remote']);
		const { fetchFn } = serve({
			[regionPath('pacific')]: json(regionOf('pacific', { listings: [{ i: 1, junk: true }] })),
			[regionPath('mountain')]: json(regionOf('mountain', { pullDate: '2026-10-14' })),
			[regionPath('new-england')]: json(regionOf('remote')),
			[regionPath('remote')]: json(regionOf('remote'))
		});
		const result = await fetchRegionFiles(
			index,
			['pacific', 'mountain', 'new-england', 'remote'],
			fetchFn
		);
		expect([...result.files.keys()]).toEqual(['remote']);
		expect(result.dropped).toEqual(['new-england', 'mountain', 'pacific']);
	});

	it('drops a file whose request fails or whose body is unreadable, and still returns the others', async () => {
		const index = indexOf(['pacific', 'mountain', 'remote', 'unknown']);
		const { fetchFn } = serve({
			[regionPath('pacific')]: new Response('x', { status: 503 }),
			[regionPath('mountain')]: new Uint8Array([0xc3, 0x28]),
			[regionPath('remote')]: json(regionOf('remote'))
			// 'unknown' is answered with a 404 by the server
		});
		const result = await fetchRegionFiles(
			index,
			['pacific', 'mountain', 'remote', 'unknown'],
			fetchFn
		);
		expect([...result.files.keys()]).toEqual(['remote']);
		expect(result.dropped).toEqual(['mountain', 'pacific', 'unknown']);
	});

	it('drops a file when the network call itself throws', async () => {
		const fetchFn: FetchFn = (url) =>
			url === regionPath('pacific')
				? Promise.reject(new TypeError('network down'))
				: Promise.resolve(new Response(json(regionOf('remote'))));
		const result = await fetchRegionFiles(
			indexOf(['pacific', 'remote']),
			['pacific', 'remote'],
			fetchFn
		);
		expect([...result.files.keys()]).toEqual(['remote']);
		expect(result.dropped).toEqual(['pacific']);
	});

	// The index is the list of what exists; asking for anything else would only draw a 404 and reveal the choice.
	it('requests only names that are both wanted and listed in the index', async () => {
		const { fetchFn, calls } = serve({
			[regionPath('pacific')]: json(regionOf('pacific')),
			[regionPath('remote')]: json(regionOf('remote'))
		});
		const result = await fetchRegionFiles(
			indexOf(['pacific', 'remote', 'mountain']),
			['pacific', 'territories'],
			fetchFn
		);
		expect(calls.map((c) => c.url)).toEqual([regionPath('pacific')]);
		expect([...result.files.keys()]).toEqual(['pacific']);
		expect(result.dropped).toEqual([]);
	});

	// The index states how big each file is. A body past that is not the file the index described, and reading it
	// whole would let a server hand over far more than the index promised.
	it('drops a file larger than the size the index declares for it, and keeps one that fits exactly', async () => {
		const body = json(regionOf('pacific'));
		const size = new TextEncoder().encode(body).length;
		const { fetchFn } = serve({ [regionPath('pacific')]: body });
		const read = (declared: number) =>
			fetchRegionFiles(indexOf(['pacific'], PULL, declared), ['pacific'], fetchFn);

		expect([...(await read(size)).files.keys()]).toEqual(['pacific']);
		expect((await read(size - 1)).dropped).toEqual(['pacific']);
		expect((await read(10)).dropped).toEqual(['pacific']);
	});

	// An index that declares more than the global cap cannot raise it.
	it('never reads past the global file cap, whatever the index declares', async () => {
		// Valid JSON once read, but 11 MB of it is padding: only the cap keeps it out.
		const padded = ' '.repeat(11 * 1024 * 1024) + json(regionOf('pacific'));
		const { fetchFn } = serve({ [regionPath('pacific')]: padded });
		const result = await fetchRegionFiles(
			indexOf(['pacific'], PULL, 50 * 1024 * 1024),
			['pacific'],
			fetchFn
		);
		expect(result.dropped).toEqual(['pacific']);
	});

	// The first division in the fixed order is the one a person's home resolves to; the caller's order must not
	// choose among several that match.
	it('requests in the fixed file order, whatever order the names come in', async () => {
		const { fetchFn, calls } = serve({
			[regionPath('middle-atlantic')]: json(regionOf('middle-atlantic')),
			[regionPath('south-atlantic')]: json(regionOf('south-atlantic')),
			[regionPath('remote')]: json(regionOf('remote'))
		});
		const result = await fetchRegionFiles(
			indexOf(['south-atlantic', 'middle-atlantic', 'remote']),
			['remote', 'south-atlantic', 'middle-atlantic'],
			fetchFn
		);
		expect(calls.map((c) => c.url)).toEqual([
			regionPath('middle-atlantic'),
			regionPath('south-atlantic'),
			regionPath('remote')
		]);
		expect([...result.files.keys()]).toEqual(['middle-atlantic', 'south-atlantic', 'remote']);
	});

	it('never has more than 3 requests in flight', async () => {
		let inFlight = 0;
		let peak = 0;
		let started = 0;
		const fetchFn: FetchFn = async (url) => {
			started += 1;
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
			const name = url.split('/').pop()?.replace('.json', '') ?? '';
			return new Response(json(regionOf(name)));
		};
		const result = await fetchRegionFiles(indexOf(DIVISIONS), DIVISIONS, fetchFn);
		expect(started).toBe(DIVISIONS.length);
		expect(result.files.size).toBe(DIVISIONS.length);
		expect(peak).toBe(3);
	});
});

describe('fetchDataFile', () => {
	const ids = { v: 1, pullDate: PULL, ids: [[1001, '2026-10-14']], aliases: [] };
	const zips = { v: 1, rows: [['21046', 'MD', 39.2, -76.86]] };
	const crosswalk = {
		v: 1,
		rows: [['91B', 'Army', '49-3023.00', 'Automotive Service Technicians and Mechanics']]
	};

	// Each table's own validator must be the one that runs: another kind's valid body is not valid here.
	const cases = [
		{ file: { kind: 'table', name: 'zips' }, good: zips, wrong: crosswalk },
		{ file: { kind: 'table', name: 'crosswalk' }, good: crosswalk, wrong: ids }
	] as const;

	it.each(cases)('returns a valid $file.name table and refuses another kind', async (c) => {
		const url = dataPath(c.file);
		const ok = serve({ [url]: json(c.good) });
		expect(await fetchDataFile(c.file, ok.fetchFn)).toEqual(c.good);

		const bad = serve({ [url]: json(c.wrong) });
		await expect(fetchDataFile(c.file, bad.fetchFn)).rejects.toThrow('E_SBF_INVALID');
	});

	// A pull date chosen by the caller would put a device-held value (the newest week seen) into a URL.
	it('takes no ids or changes file, which is the pull date of the index alone', async () => {
		const { fetchFn, calls } = serve({});
		for (const kind of ['ids', 'changes']) {
			const free = { kind, pullDate: '2020-01-01' } as unknown as Parameters<
				typeof fetchDataFile
			>[0];
			await expect(fetchDataFile(free, fetchFn)).rejects.toThrow('E_SBF_BAD_PATH');
		}
		expect(calls).toEqual([]);
	});
});

describe('fetchWeekFile', () => {
	const ids = { v: 1, pullDate: PULL, ids: [[1001, '2026-10-14']], aliases: [] };
	const older = { pullDate: '2026-10-14', added: [], removed: [], newOrgs: [] };
	const changes = {
		v: 1,
		weeks: [{ pullDate: PULL, added: [1], removed: [], newOrgs: [] }]
	};
	const zips = { v: 1, rows: [['21046', 'MD', 39.2, -76.86]] };
	const index = indexOf(['pacific']);
	const idsPath = `/skillbridge-data/w/${PULL}/ids.json`;
	const changesPath = `/skillbridge-data/w/${PULL}/changes.json`;

	// The date in the URL is the index's own, never one the caller passes.
	it("requests the index's pull date for the ids and changes files", async () => {
		const { fetchFn, calls } = serve({ [idsPath]: json(ids), [changesPath]: json(changes) });
		expect(await fetchWeekFile(index, 'ids', fetchFn)).toEqual(ids);
		expect(await fetchWeekFile(index, 'changes', fetchFn)).toEqual(changes);
		expect(calls.map((c) => c.url)).toEqual([idsPath, changesPath]);
		for (const call of calls) expect(call.init).toStrictEqual(EXPECTED_INIT);
	});

	it('refuses another kind of body at each path', async () => {
		const wrongIds = serve({ [idsPath]: json(changes) });
		await expect(fetchWeekFile(index, 'ids', wrongIds.fetchFn)).rejects.toThrow('E_SBF_INVALID');
		const wrongChanges = serve({ [changesPath]: json(zips) });
		await expect(fetchWeekFile(index, 'changes', wrongChanges.fetchFn)).rejects.toThrow(
			'E_SBF_INVALID'
		);
	});

	// A stale copy served at this week's path would show last week's listings as current.
	it('refuses an ids file from another pull than the index', async () => {
		const stale = serve({ [idsPath]: json({ ...ids, pullDate: '2026-10-14' }) });
		await expect(fetchWeekFile(index, 'ids', stale.fetchFn)).rejects.toThrow('E_SBF_INVALID');
	});

	// The changes file lists this week and last; the folder's week is the newest one it describes.
	it('refuses a changes file whose newest week is not the index pull', async () => {
		const stale = serve({ [changesPath]: json({ v: 1, weeks: [older] }) });
		await expect(fetchWeekFile(index, 'changes', stale.fetchFn)).rejects.toThrow('E_SBF_INVALID');

		const twoWeeks = { v: 1, weeks: [changes.weeks[0], older] };
		const ok = serve({ [changesPath]: json(twoWeeks) });
		expect(await fetchWeekFile(index, 'changes', ok.fetchFn)).toEqual(twoWeeks);
	});
});
