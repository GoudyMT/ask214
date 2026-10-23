import type { ChangesFile, IdsFile, IndexFile, Listing, RegionFile } from '../contract/listing';
import { STATE_EXTENTS } from '../contract/state-extents';
import type { RegionFileName } from '../contract/places';
import type { ZipsTable } from '../contract/tables';
import {
	fetchDataFile,
	fetchIndex,
	fetchRegionFiles,
	fetchWeekFile,
	type FetchFn
} from '../fetch/fetch-files';
import { buildSearchIndex, search, type SearchIndex } from '../search/index';
import { placePoint } from '../state/distance';
import { matchListings, mergeRegionListings, type Match } from '../state/match';
import { isNew, isRollback } from '../state/new-rule';
import type { FinderPackStore } from '../state/pack-store.svelte';
import { savedStatus, type SavedStatus } from '../state/saved-status';
import { selectRegionFiles, type SelectInput } from '../state/select-files';
import type { FinderStore } from '../state/store.svelte';
import type { FinderFilters, FinderSetup } from '../state/types';
import { safeLog } from '../../log/safelog';
import { workerBypassesFinderData } from '../../sw/finder-bypass';

/**
 * One visit to the finder: the held week opened at once, the network asked for what the person's place needs, and the
 * list, New marks and search read from what is held. Everything decrypted lives here only until the pack relocks.
 *
 * The network is handed fixed file names and nothing else (see fetch/); the place only chooses which names.
 */

export type FinderSessionOptions = {
	finder: FinderStore;
	pack: FinderPackStore;
	fetchFn?: FetchFn;
	now?: () => number;
	/** Asked before every request; false keeps the session on what is held. */
	canFetch?: () => boolean;
	/**
	 * Asked once before the first download of each start. False (an older worker in charge that would keep a copy of
	 * every file fetched) stops every download: the state is 'failed' with `downloadBlocked`, never 'offline'.
	 */
	workerPassesData?: () => Promise<boolean>;
};

export type FinderSessionStatus = 'loading' | 'ready' | 'offline' | 'failed';

const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;

const dayOf = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / MS_PER_DAY;

// Plain collections, held whole and replaced: nothing reads one where a template could see an in-place change.
const mapOf = <K, V>(entries?: Iterable<readonly [K, V]>) => new Map<K, V>(entries);
const setOf = <T>(items?: Iterable<T>) => new Set<T>(items);

export function createFinderSession(opts: FinderSessionOptions) {
	const { finder, pack } = opts;
	const now = opts.now ?? Date.now;
	const canFetch = opts.canFetch ?? (() => true);
	const baseFetch: FetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
	const workerPassesData = opts.workerPassesData ?? workerBypassesFinderData;
	// One answer per start, asked at the first request: no copy of a file may be kept by a worker that would keep one.
	let passes: Promise<boolean> | null = null;
	let _blocked = $state(false);
	// Every request goes through here, so the guards are asked before each one and none can slip past them.
	const fetchFn: FetchFn = async (input, init) => {
		if (!canFetch()) throw new TypeError('E_FINDER_NO_FETCH');
		passes ??= workerPassesData().catch(() => false);
		if (!(await passes)) {
			_blocked = true;
			throw new TypeError('E_FINDER_NO_FETCH');
		}
		return baseFetch(input, init);
	};

	let _status = $state<FinderSessionStatus>('loading');
	let _held = $state.raw<ReadonlyMap<RegionFileName, RegionFile>>(mapOf());
	let _listings = $state.raw<Listing[]>([]);
	let _ids = $state.raw<IdsFile | undefined>(undefined);
	let _changes = $state.raw<ChangesFile | undefined>(undefined);
	let _zips = $state.raw<ZipsTable | undefined>(undefined);
	let _query = $state('');
	let _missedWeeks = $state(0);
	// Bumped by a relock: work that began before it must not put anything back.
	let epoch = 0;
	let running: Promise<void> | null = null;
	// The files the running visit chose to download, so a start that finds it running can tell whether the person has
	// moved the setup since; `again` asks that visit to run once more when they have.
	let askedFor: string | null = null;
	let again = false;

	// Plain variables, not deriveds: a derived keeps its last value alive until something reads it again, and a relock
	// must leave nothing decrypted behind.
	let searchIndex: { listings: Listing[]; index: SearchIndex } | null = null;
	let matchMemo: { key: string; listings: Listing[]; rows: Match[] } | null = null;
	let byId: { listings: Listing[]; map: Map<number, Listing> } | null = null;

	const off = pack.onDrop(() => {
		epoch++;
		again = false;
		_held = mapOf();
		_listings = [];
		_ids = undefined;
		_changes = undefined;
		_zips = undefined;
		_query = '';
		_missedWeeks = 0;
		_status = 'loading';
		searchIndex = null;
		matchMemo = null;
		byId = null;
	});

	function setup(): FinderSetup {
		return finder.ready ? finder.setup : {};
	}

	function point() {
		const place = setup().place;
		return place?.kind === 'zip' ? placePoint(place, _zips) : null;
	}

	/** The files a place needs; with no usable place only the remote and many-state files (and flagged extras). */
	function wantedFiles(searchAll: boolean): RegionFileName[] {
		const s = setup();
		const where = point();
		let place: SelectInput['place'];
		if (where) place = { kind: 'point', la: where.la, lo: where.lo, state: where.state };
		else if (s.place?.kind === 'state') place = { kind: 'state', state: s.place.state };
		const input: SelectInput = {
			...(place ? { place } : {}),
			...(s.radius !== undefined ? { radiusMiles: s.radius } : {}),
			...(s.territories ? { territories: true } : {}),
			...(s.overseas ? { overseas: true } : {}),
			...(searchAll ? { searchAll: true } : {})
		};
		return selectRegionFiles(input, STATE_EXTENTS);
	}

	async function readHeld(retry = true): Promise<void> {
		const at = epoch;
		const index = pack.index;
		if (index === undefined) {
			_held = mapOf();
			_listings = [];
			_ids = undefined;
			_changes = undefined;
			return;
		}
		const read = async <T>(fn: () => Promise<T | undefined>): Promise<T | undefined> => {
			try {
				return await fn();
			} catch (e) {
				// Another tab moved the week on: the files on disk are good, this tab only needs to read them. Clearing
				// them here would download the week again for nothing.
				if (e instanceof Error && e.message === 'E_FINDER_PACK_STALE') throw e;
				safeLog({ code: 'E_INTERNAL' });
				return undefined;
			}
		};
		let files: (RegionFile | undefined)[];
		let ids: IdsFile | undefined;
		let changes: ChangesFile | undefined;
		try {
			[files, ids, changes] = await Promise.all([
				Promise.all(index.files.map((f) => read(() => pack.readRegion(f.name)))),
				read(() => pack.readIds()),
				read(() => pack.readChanges())
			]);
		} catch (e) {
			if (!retry) throw e;
			// The answer can arrive after a lock: reading again would open a pack the person closed.
			if (at !== epoch || pack.locked) return;
			await pack.load();
			return readHeld(false);
		}
		if (at !== epoch) return;
		const held = mapOf<RegionFileName, RegionFile>();
		index.files.forEach((f, n) => {
			const file = files[n];
			if (file) held.set(f.name, file);
		});
		_held = held;
		_listings = mergeRegionListings(held.values());
		_ids = ids;
		_changes = changes;
	}

	/**
	 * Opens the pack when the caller has not; a locked pack stays shut, and unreadable rows are cleared and read again.
	 * A load that ends early because a lock landed meanwhile returns without error and leaves the pack shut, so the answer
	 * is whether the pack is open now.
	 */
	async function openPack(): Promise<boolean> {
		if (pack.ready) return true;
		if (pack.locked) return false;
		// Read first even after an earlier failed open: another tab may have recovered the rows since, and clearing them now
		// would throw its download away.
		try {
			await pack.load();
			return pack.ready;
		} catch {
			if (!pack.failed) return false;
		}
		try {
			await pack.drop();
			await pack.load();
			return pack.ready;
		} catch {
			return false;
		}
	}

	async function zipsTable(): Promise<ZipsTable | undefined> {
		if (_zips) return _zips;
		const at = epoch;
		let table: ZipsTable | undefined;
		try {
			table = (await pack.readTable('zips')) as ZipsTable | undefined;
		} catch {
			table = undefined;
		}
		if (table === undefined) {
			try {
				table = await fetchDataFile({ kind: 'table', name: 'zips' }, fetchFn);
				await pack.putTable('zips', table);
			} catch {
				// Kept only when it was fetched whole; a table that cannot be fetched or kept is used for this visit if got.
			}
		}
		if (at === epoch && table) _zips = table;
		return at === epoch ? table : undefined;
	}

	/** Fetches what `names` lacks of the index's week, and swaps it in with the week's ids and changes. */
	async function download(index: IndexFile, names: RegionFileName[]): Promise<boolean> {
		const at = epoch;
		const sameWeek = pack.pullDate === index.pullDate;
		const missing = sameWeek ? names.filter((n) => !_held.has(n)) : names;
		const needIds = !sameWeek || _ids === undefined;
		const needChanges = !sameWeek || _changes === undefined;
		if (sameWeek && missing.length === 0 && !needIds && !needChanges) return true;

		const [regions, ids, changes] = await Promise.all([
			fetchRegionFiles(index, missing, fetchFn),
			needIds ? fetchWeekFile(index, 'ids', fetchFn).catch(() => undefined) : undefined,
			needChanges ? fetchWeekFile(index, 'changes', fetchFn).catch(() => undefined) : undefined
		]);
		if (at !== epoch) return false;
		// A region file missing would leave a hole in the list that reads as "nothing near you".
		if (regions.dropped.length > 0) return false;
		// A week that replaces the held one takes its ids and changes with it: without them the old rows would be deleted
		// and every New mark would read as "not new". Within one week, or with nothing held yet, there is nothing to lose
		// by keeping what arrived, and the missing file is asked for again on the next visit.
		if (pack.pullDate !== undefined && !sameWeek && (!ids || !changes)) return false;
		await pack.swap({
			index,
			regions: regions.files,
			...(ids ? { ids } : {}),
			...(changes ? { changes } : {})
		});
		return at === epoch;
	}

	async function run(): Promise<void> {
		if (!(await openPack())) {
			_status = 'failed';
			return;
		}
		// After the open: clearing unreadable rows tells the listeners, which is not a lock to give up on.
		const at = epoch;
		const previouslySeen = pack.lastSeenPull;
		_status = 'loading';
		passes = null;
		_blocked = false;
		// A ZIP is a point only through the table; it is read before the list so the first sight is already nearest-first.
		if (setup().place?.kind === 'zip') await zipsTable();
		try {
			await readHeld();
		} catch {
			_status = 'failed';
			return;
		}
		if (at !== epoch) return;
		if (pack.index !== undefined) _status = 'ready';

		let outcome: FinderSessionStatus = 'ready';
		try {
			const index = await fetchIndex(fetchFn, now);
			if (at !== epoch) return;
			if (!isRollback(pack.pullDate, index.pullDate)) {
				const wanted = wantedFiles(false);
				askedFor = wanted.join(',');
				if (!(await download(index, wanted))) outcome = 'offline';
				if (at !== epoch) return;
				await readHeld();
			}
		} catch {
			outcome = 'offline';
		}
		if (at !== epoch) return;
		// A download the worker would have kept a copy of is not offline: the network may be fine.
		_status = _blocked ? 'failed' : outcome;

		const pull = pack.pullDate;
		if (pull !== undefined) {
			const weeks =
				previouslySeen === undefined ? 0 : (dayOf(pull) - dayOf(previouslySeen)) / DAYS_PER_WEEK;
			_missedWeeks = Math.max(0, Math.floor(weeks));
			// The list is on screen for this pull: it is the newest the person has now seen.
			await pack.advanceLastSeen(pull).catch(() => safeLog({ code: 'E_INTERNAL' }));
		}
	}

	/** One visit, and one more for each time the setup moved on while it was downloading. */
	async function visits(): Promise<void> {
		do {
			again = false;
			askedFor = null;
			await run();
		} while (again);
	}

	function listingsById(): Map<number, Listing> {
		if (byId?.listings !== _listings) {
			byId = { listings: _listings, map: mapOf(_listings.map((l) => [l.i, l] as const)) };
		}
		return byId.map;
	}

	function isNewId(id: number): boolean {
		const index = pack.index;
		const listing = listingsById().get(id);
		if (!index || !listing || !_changes) return false;
		return isNew(listing, {
			recentPullDates: _changes.weeks.map((w) => w.pullDate),
			baselineDate: index.baselineDate,
			openedIds: pack.seen,
			keptIds: setOf([...finder.saved.map((s) => s.id), ...finder.compare])
		});
	}

	function inState(listing: Listing, state: string): boolean {
		return listing.s === state || listing.ls?.some((s) => s === state) === true;
	}

	/** The listings that pass `filters` and the person's place, in list order. */
	function matchesFor(filters: FinderFilters): Match[] {
		const s = setup();
		const where = point();
		let rows = matchListings(_listings, {
			filters,
			point: where,
			...(s.radius !== undefined ? { radius: s.radius } : {})
		});
		// A state place has no centre to measure from, so the division's other states are left out by name.
		if (s.place?.kind === 'state') {
			const state = s.place.state;
			rows = rows.filter(
				(r) =>
					r.placement.kind === 'remote' ||
					r.placement.kind === 'unlisted' ||
					inState(r.listing, state)
			);
		}
		return rows;
	}

	function computeMatches(): Match[] {
		const filters = finder.ready ? finder.filters : {};
		const key = JSON.stringify([filters, setup(), point()]);
		if (matchMemo && matchMemo.key === key && matchMemo.listings === _listings)
			return matchMemo.rows;
		const rows = matchesFor(filters);
		matchMemo = { key, listings: _listings, rows };
		return rows;
	}

	function computeResults(): Match[] {
		const rows = computeMatches();
		if (_query.trim() === '') return rows;
		if (searchIndex?.listings !== _listings) {
			searchIndex = { listings: _listings, index: buildSearchIndex(_listings) };
		}
		const found = setOf(search(searchIndex.index, _query));
		return rows.filter((r) => found.has(r.listing.i));
	}

	function notHeldForAll(): { name: RegionFileName; bytes: number }[] {
		const index = pack.index;
		if (index === undefined) return [];
		const want = setOf(wantedFiles(true));
		return index.files.filter((f) => want.has(f.name) && !_held.has(f.name));
	}

	return {
		get status(): FinderSessionStatus {
			return _status;
		},
		get listings(): Listing[] {
			return _listings;
		},
		get matches(): Match[] {
			return computeMatches();
		},
		/** What the list would hold under other filters, for the counts beside each filter value. Not kept. */
		matchesWith: matchesFor,
		get query(): string {
			return _query;
		},
		set query(value: string) {
			_query = value;
		},
		get results(): Match[] {
			return computeResults();
		},
		get pullDate(): string | undefined {
			return pack.pullDate;
		},
		/** Whole days from the pull date to the device clock; 0 with nothing held. */
		get staleDays(): number {
			const pull = pack.pullDate;
			return pull === undefined ? 0 : Math.max(0, Math.floor(now() / MS_PER_DAY - dayOf(pull)));
		},
		/** True when a download was refused because an older worker would keep a copy of each file. */
		get downloadBlocked(): boolean {
			return _blocked;
		},
		get missedWeeks(): number {
			return _missedWeeks;
		},
		/** With no place the person has only the near-nowhere files; the rest wait for an ask. */
		get needsSearchAll(): boolean {
			return setup().place === undefined && notHeldForAll().length > 0;
		},
		get searchAllBytes(): number {
			return setup().place === undefined ? notHeldForAll().reduce((sum, f) => sum + f.bytes, 0) : 0;
		},
		/** Whether a search index is held (it goes with the listings on a relock). */
		get indexHeld(): boolean {
			return searchIndex !== null;
		},
		get zips(): ZipsTable | undefined {
			return _zips;
		},
		isNewId,
		/** A saved program still listed or not; unknown (no ids file held) reads as listed. */
		savedStatus(id: number): SavedStatus {
			return _ids ? savedStatus(id, _ids, _changes) : { kind: 'listed', id };
		},
		start(): Promise<void> {
			if (running) {
				// A visit already downloading chose its files from the setup of that moment.
				if (askedFor !== null && askedFor !== wantedFiles(false).join(',')) again = true;
				return running;
			}
			running = visits().finally(() => {
				running = null;
				askedFor = null;
			});
			return running;
		},
		async searchAll(): Promise<void> {
			const at = epoch;
			const index = pack.index;
			if (index === undefined) return;
			try {
				if (await download(index, wantedFiles(true))) await readHeld();
			} catch {
				if (at === epoch) _status = _blocked ? 'failed' : 'offline';
			}
		},
		ensureZips: zipsTable,
		async markOpened(id: number): Promise<void> {
			try {
				await pack.markOpened([id]);
			} catch {
				safeLog({ code: 'E_INTERNAL' });
			}
		},
		async markAllSeen(): Promise<void> {
			const pull = pack.pullDate;
			const newIds = computeMatches()
				.map((r) => r.listing.i)
				.filter(isNewId);
			try {
				await pack.markOpened(newIds);
				if (pull !== undefined) await pack.advanceLastSeen(pull);
			} catch {
				safeLog({ code: 'E_INTERNAL' });
			}
		},
		destroy(): void {
			off();
		}
	};
}

export type FinderSession = ReturnType<typeof createFinderSession>;
