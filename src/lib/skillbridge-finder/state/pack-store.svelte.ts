import {
	MAX_PULL_DAYS_AHEAD,
	type ChangesFile,
	type IdsFile,
	type IndexFile,
	type RegionFile
} from '../contract/listing';
import {
	REGION_FILE_NAMES,
	TABLE_FILE_NAMES,
	isIsoDate,
	isRegionFileName,
	type RegionFileName,
	type TableFileName
} from '../contract/places';
import {
	validateCrosswalk,
	validateZips,
	type CrosswalkTable,
	type ZipsTable
} from '../contract/tables';
import {
	validateChanges,
	validateIds,
	validateIndex,
	validateRegionFile,
	type ContractResult
} from '../contract/validate';
import { decodeSeen, encodeSeen, FinderPackError, type FinderSeenRow } from './pack-codec';
import { isRollback, nextLastSeen } from './new-rule';
import { encryptRecord, decryptRecord } from '../../crypto/record-crypto';
import { AesGcmAuthError } from '../../crypto/aes-gcm';
import type { KeystoreRecordV1 } from '../../keystore/record';
import { nextLockState, type LockState, type RelockReason } from '../../profile/lifecycle';
import { readKeystoreRow } from '../../profile/store.svelte';
import { LOCK_TIMEOUT_MS, LockAcquisitionTimeout } from '../../db/locks';
import { withStores, reqToPromise } from '../../db/schema';
import { safeLog } from '../../log/safelog';

/**
 * FinderPackStore - the SkillBridge finder's downloaded data files, kept on the device so the finder opens at once and
 * works offline. Every file is ONE encrypted row (`{ id: <row key>, rec }`), and each row's AAD binds it to its key and,
 * for the weekly files, to the pull date, so a row copied to another key or kept from another week fails to decrypt.
 * There is no high-water-mark sidecar: the files are public and can be fetched again, and the week only moves forward
 * because a swap compares the new index with the one on disk - except a held index dated more than a week ahead, which
 * counts as nothing held, so a broken date can never block every real week after it.
 *
 * Nothing here takes the `profile-write` lock, which times out at 10 s and would stall every profile save behind
 * multi-MB files. A write holds the keystore lock SHARED (so an erase, which holds it exclusive, is the last writer and
 * a swap cannot resurrect rows into a wiped database) and its own `skillbridge-finder-pack` lock for the part that must
 * be atomic; files are encrypted before that lock is taken. The seen row is read-modify-written under that lock,
 * re-read inside it, so two tabs' marks both land.
 *
 * Decrypted files are memoized until a relock. A relock drops every one, bumps an epoch so a read already in flight
 * cannot put its result back, and tells the listeners (the search index and sorted results) to drop theirs. It never
 * re-reads on its own.
 */

const PACK_STORE = 'skillbridge-finder-pack';
const LOCK_NAME = 'skillbridge-finder-pack';
const GENERATION = 0;

// A held week dated further ahead than MAX_PULL_DAYS_AHEAD is a pipeline typo or a hostile deploy; kept, it would make
// every real week after it look like a rollback.
const MS_PER_DAY = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

type PackTable = ZipsTable | CrosswalkTable;
type RowKey = 'index' | 'ids' | 'changes' | 'seen' | RegionFileName | `table:${TableFileName}`;
type Row = { id: string; rec: Uint8Array };

/** The rows of one week: replaced as a set when a newer week arrives. `seen` and the tables outlive it. */
const WEEK_KEYS: readonly string[] = [...REGION_FILE_NAMES, 'ids', 'changes', 'index'];

const TABLE_VALIDATORS: Record<TableFileName, (raw: unknown) => ContractResult> = {
	zips: validateZips,
	crosswalk: validateCrosswalk
};

export type FinderPackSwap = {
	index: IndexFile;
	regions: Map<RegionFileName, RegionFile>;
	ids?: IdsFile;
	changes?: ChangesFile;
};

// A plain Set, held as a whole value and replaced: nothing reads it where a template could see an in-place change.
const setOf = <T>(items: Iterable<T> = []): Set<T> => new Set(items);

const isObject = (x: unknown): x is Record<string, unknown> =>
	typeof x === 'object' && x !== null && !Array.isArray(x);

/** Whether `value` is a valid file for its row: the contract's own validator, and a region file names its own key. */
function isValidFile(key: RowKey, value: unknown): boolean {
	if (key === 'index') return validateIndex(value).valid;
	if (key === 'ids') return validateIds(value).valid;
	if (key === 'changes') return validateChanges(value).valid;
	if (key === 'seen') return false;
	if (key.startsWith('table:')) {
		return TABLE_VALIDATORS[key.slice('table:'.length) as TableFileName](value).valid;
	}
	return validateRegionFile(value).valid && isObject(value) && value.file === key;
}

/**
 * The weekly files carry the week they belong to; it must be the index's. A changes file lists its weeks newest first,
 * so its first week is the one it was cut for; one with no weeks says nothing about any week and is refused.
 */
function isOfWeek(key: RowKey, value: unknown, pull: string): boolean {
	if (key === 'seen' || key === 'index' || key.startsWith('table:')) return true;
	if (key === 'changes') {
		if (!isObject(value) || !Array.isArray(value.weeks)) return false;
		const newest: unknown = value.weeks[0];
		return isObject(newest) && newest.pullDate === pull;
	}
	return isObject(value) && value.pullDate === pull;
}

function recordIdOf(key: RowKey, pull: string | undefined): string {
	if (key === 'index' || key === 'seen' || key.startsWith('table:')) return key;
	if (pull === undefined) throw new FinderPackError('E_FINDER_PACK_BAD_ROW');
	return `${key}@${pull}`;
}

async function sealBytes(
	keystore: KeystoreRecordV1,
	recordId: string,
	bytes: Uint8Array
): Promise<Uint8Array> {
	try {
		return await encryptRecord(
			{ storeName: PACK_STORE, recordId, schemaVersion: 1 },
			bytes,
			keystore,
			GENERATION
		);
	} finally {
		// The cipher keeps its own copy, and the ciphertext is all that is stored.
		bytes.fill(0);
	}
}

/** Decrypts one row; a blob that fails its check (wrong key, wrong week, damaged) is a bad row, never data. */
async function openBytes(
	keystore: KeystoreRecordV1,
	recordId: string,
	rec: Uint8Array
): Promise<Uint8Array> {
	try {
		return await decryptRecord(
			{ storeName: PACK_STORE, recordId, schemaVersion: 1 },
			rec,
			keystore,
			GENERATION
		);
	} catch (e) {
		if (e instanceof AesGcmAuthError) throw new FinderPackError('E_FINDER_PACK_BAD_ROW');
		throw e;
	}
}

function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new FinderPackError('E_FINDER_PACK_BAD_ROW');
	}
}

/** One IndexedDB lock request, bounded; an abort or timeout is the typed lock timeout, not a raw DOMException. */
async function requestLock<T>(name: string, mode: LockMode, fn: () => Promise<T>): Promise<T> {
	try {
		return await navigator.locks.request(
			name,
			{ mode, signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
			fn
		);
	} catch (e) {
		if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
			throw new LockAcquisitionTimeout();
		}
		throw e;
	}
}

const withKeystoreShared = <T>(fn: () => Promise<T>) => requestLock('mtc-keystore', 'shared', fn);
const withPackLock = <T>(fn: () => Promise<T>) => requestLock(LOCK_NAME, 'exclusive', fn);

const getRow = (db: IDBDatabase, key: string) =>
	withStores(db, PACK_STORE, 'readonly', (tx) =>
		reqToPromise<Row | undefined>(tx.objectStore(PACK_STORE).get(key))
	);

/** `now` is the device clock in ms; it is a parameter so the far-future bound can be tested without waiting for a date. */
export function createFinderPackStore(db: IDBDatabase, now: () => number = Date.now) {
	/** Whether a week's date is more than MAX_PULL_DAYS_AHEAD after the device's UTC day. An unreadable date is not far ahead. */
	function isFarFuture(pull: string): boolean {
		const parts = DATE_RE.exec(pull);
		if (parts === null) return false;
		const pullDay = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) / MS_PER_DAY;
		return pullDay - Math.floor(now() / MS_PER_DAY) > MAX_PULL_DAYS_AHEAD;
	}

	let _ready = $state(false);
	let _failed = $state(false);
	let _index = $state.raw<IndexFile | undefined>(undefined);
	let _seen = $state.raw<ReadonlySet<number>>(setOf());
	let _lastSeenPull = $state.raw<string | undefined>(undefined);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- read only imperatively; nothing reactive depends on it
	const memo = new Map<string, unknown>();
	const listeners = setOf<() => void>();
	// Bumped by a relock or a drop: a read or load that began before it must not put anything back.
	let epoch = 0;
	// Bumped by drop(), inside the pack lock, as the rows are cleared: a write that began before it and only now has the
	// lock would put the dropped week or the opened ids back on disk, where the next load reads them.
	let dropEpoch = 0;
	// How this store came to hold nothing decrypted. Only the person's own load() opens a `locked` store; an automatic
	// re-read (refresh) may undo `evicted`, which is page hygiene on the way out.
	let lockState = $state<LockState>('unlocked');
	// Bumped whenever the memo is cleared for new data: a read that began before it must not memoize the old file.
	let memoVersion = 0;

	function clearMemo(): void {
		memo.clear();
		memoVersion++;
	}

	function clearHeld(): void {
		clearMemo();
		_index = undefined;
		_seen = setOf();
		_lastSeenPull = undefined;
	}

	function notifyDropped(): void {
		for (const fn of [...listeners]) {
			try {
				fn();
			} catch {
				// One listener failing must not leave the others holding decrypted data.
				safeLog({ code: 'E_INTERNAL' });
			}
		}
	}

	function requireReady(): void {
		if (!_ready) throw new FinderPackError('E_FINDER_PACK_RELOCKED');
	}

	/** Called inside the pack lock, before a write's transaction: a drop that ran since the write began wins. */
	function requireNotDropped(dropEpochAtStart: number): void {
		if (dropEpoch !== dropEpochAtStart) throw new FinderPackError('E_FINDER_PACK_RELOCKED');
	}

	function putRows(tx: IDBTransaction, rows: Row[]): void {
		const store = tx.objectStore(PACK_STORE);
		for (const row of rows) {
			// eslint-disable-next-line mtc/encrypted-store-registry -- THE sanctioned encryption-boundary write: ciphertext from encryptRecord, under the keystore and pack locks.
			store.put(row);
		}
	}

	async function sealFile(
		keystore: KeystoreRecordV1,
		key: RowKey,
		pull: string | undefined,
		value: unknown
	): Promise<Row> {
		const rec = await sealBytes(
			keystore,
			recordIdOf(key, pull),
			new TextEncoder().encode(JSON.stringify(value))
		);
		return { id: key, rec };
	}

	/** Decrypts and re-validates a file row: it must pass the contract, name its own key and belong to `pull`. */
	async function openFile(
		keystore: KeystoreRecordV1,
		key: RowKey,
		pull: string | undefined,
		rec: Uint8Array
	): Promise<unknown> {
		const bytes = await openBytes(keystore, recordIdOf(key, pull), rec);
		let value: unknown;
		try {
			value = parseJson(bytes);
		} finally {
			bytes.fill(0);
		}
		if (!isValidFile(key, value) || (pull !== undefined && !isOfWeek(key, value, pull))) {
			throw new FinderPackError('E_FINDER_PACK_BAD_ROW');
		}
		return value;
	}

	async function openSeen(keystore: KeystoreRecordV1, rec: Uint8Array): Promise<FinderSeenRow> {
		const bytes = await openBytes(keystore, 'seen', rec);
		try {
			return decodeSeen(bytes);
		} finally {
			bytes.fill(0);
		}
	}

	async function readStoredIndex(keystore: KeystoreRecordV1): Promise<IndexFile | undefined> {
		const row = await getRow(db, 'index');
		return row ? ((await openFile(keystore, 'index', undefined, row.rec)) as IndexFile) : undefined;
	}

	/**
	 * Whether the disk holds a different week than the one this tab holds (`pull`). A weekly row that fails its check
	 * then means this tab is behind a peer's swap (or a peer's drop), not that the row is damaged. Only the index row is
	 * read; if that one does not read either, the row is judged on its own and nothing is claimed about the week.
	 */
	async function weekMovedOnDisk(keystore: KeystoreRecordV1, pull: string): Promise<boolean> {
		try {
			const onDisk = await readStoredIndex(keystore);
			return onDisk?.pullDate !== pull;
		} catch {
			return false;
		}
	}

	/** One file, decrypted on demand and held until a relock. */
	async function readFile<T>(key: RowKey): Promise<T | undefined> {
		requireReady();
		const epochAtStart = epoch;
		const versionAtStart = memoVersion;
		const isWeekly = !key.startsWith('table:');
		const pull = isWeekly ? _index?.pullDate : undefined;
		if (isWeekly && pull === undefined) return undefined;
		if (memo.has(key)) return memo.get(key) as T;
		const row = await getRow(db, key);
		if (!row) return undefined;
		const keystore = await readKeystoreRow(db);
		let value: unknown;
		try {
			value = await openFile(keystore, key, pull, row.rec);
		} catch (e) {
			if (epoch !== epochAtStart) throw new FinderPackError('E_FINDER_PACK_RELOCKED');
			if (
				pull !== undefined &&
				e instanceof FinderPackError &&
				e.message === 'E_FINDER_PACK_BAD_ROW' &&
				(await weekMovedOnDisk(keystore, pull))
			) {
				throw new FinderPackError('E_FINDER_PACK_STALE');
			}
			throw e;
		}
		// A lock that landed while this ran wins: the caller gets nothing and nothing is put back.
		if (epoch !== epochAtStart) throw new FinderPackError('E_FINDER_PACK_RELOCKED');
		if (memoVersion === versionAtStart) memo.set(key, value);
		return value as T;
	}

	function holdSeen(row: FinderSeenRow): void {
		_seen = setOf(row.finderSeen);
		_lastSeenPull = row.finderLastSeenPull;
	}

	/**
	 * Read-modify-write of the seen row, re-read inside the pack lock so a peer tab's marks are built on and not
	 * replaced. `mutate` returns null for "nothing to change".
	 */
	async function updateSeen(
		mutate: (current: FinderSeenRow) => FinderSeenRow | null
	): Promise<void> {
		requireReady();
		const epochAtStart = epoch;
		const dropAtStart = dropEpoch;
		let result: FinderSeenRow | undefined;
		await withKeystoreShared(async () => {
			const keystore = await readKeystoreRow(db);
			await withPackLock(async () => {
				requireNotDropped(dropAtStart);
				const row = await getRow(db, 'seen');
				const current = row ? await openSeen(keystore, row.rec) : { finderSeen: [] };
				const next = mutate(current);
				if (next === null) {
					result = current;
					return;
				}
				const rec = await sealBytes(keystore, 'seen', encodeSeen(next));
				await withStores(db, PACK_STORE, 'readwrite', (tx) => putRows(tx, [{ id: 'seen', rec }]));
				result = next;
			});
		});
		if (epoch === epochAtStart && result) holdSeen(result);
	}

	const api = {
		/** Whether the pack is loaded (possibly empty). FALSE before the first load, after a relock and after a failed load. */
		get ready(): boolean {
			return _ready;
		},

		/** Whether the last load failed, so the pack could not be read; the caller may drop(), load() and fetch again. */
		get failed(): boolean {
			return _failed;
		},

		/**
		 * Whether the person's lock holds: only a load they ask for opens it, and page hygiene on top of it does not move
		 * it. An automatic re-read (refresh) refuses a locked pack.
		 */
		get locked(): boolean {
			return lockState === 'locked';
		},

		/** The held week's pull date, or undefined when nothing is held. */
		get pullDate(): string | undefined {
			return _index?.pullDate;
		},

		get index(): IndexFile | undefined {
			return _index;
		},

		/** Ids of listings the person has opened; empty before load / when relocked. */
		get seen(): ReadonlySet<number> {
			return _seen;
		},

		/** The newest pull the person had seen when they last left. */
		get lastSeenPull(): string | undefined {
			return _lastSeenPull;
		},

		/**
		 * Reads the index and the seen row only; files are read on demand. An empty store is ready with nothing held. A row
		 * that fails to decrypt or validate leaves `failed` set and nothing held, and throws.
		 */
		async load(): Promise<void> {
			const epochAtStart = epoch;
			try {
				const keystore = await readKeystoreRow(db);
				const [indexRow, seenRow] = await Promise.all([getRow(db, 'index'), getRow(db, 'seen')]);
				const index = indexRow
					? ((await openFile(keystore, 'index', undefined, indexRow.rec)) as IndexFile)
					: undefined;
				const seen = seenRow ? await openSeen(keystore, seenRow.rec) : { finderSeen: [] };
				// A lock that landed while this read wins: the pack stays dropped.
				if (epoch !== epochAtStart) return;
				if (_index?.pullDate !== index?.pullDate) clearMemo();
				_index = index;
				holdSeen(seen);
				_ready = true;
				_failed = false;
				lockState = 'unlocked';
			} catch (e) {
				if (epoch === epochAtStart) {
					_ready = false;
					_failed = true;
					clearHeld();
				}
				throw e;
			}
		},

		/**
		 * AUTOMATIC re-read (a peer tab's change, a page restore). It decrypts, so it answers to how the plaintext went away:
		 * a `locked` store (the person asked, or their presence lapsed) stays as it is, an `evicted` one (page hygiene)
		 * is read again now the page is back, and a hidden page decrypts nothing because nobody can see the result.
		 * load() is not gated: Unlock and start-up use it, and they are the person asking.
		 */
		refresh(): Promise<void> {
			if (lockState === 'locked' || document.visibilityState === 'hidden') {
				return Promise.resolve();
			}
			return api.load();
		},

		readRegion: (name: RegionFileName) => readFile<RegionFile>(name),
		readIds: () => readFile<IdsFile>('ids'),
		readChanges: () => readFile<ChangesFile>('changes'),
		readTable: (name: TableFileName) => readFile<PackTable>(`table:${name}`),

		/**
		 * Replace the held week. Everything is validated first; any failure writes nothing. An older week than the one on
		 * disk is refused. The same week adds its files to the held ones; a newer week removes every old-week file row
		 * (not `seen`, not the tables) in the same transaction that puts the new set.
		 */
		async swap(input: FinderPackSwap): Promise<void> {
			requireReady();
			const { index, regions, ids, changes } = input;
			// An index that is not even an object fails the check below; this only keeps the read of its date from throwing.
			const pull = isObject(index) && typeof index.pullDate === 'string' ? index.pullDate : '';
			const files: [RowKey, unknown][] = [['index', index]];
			for (const [name, file] of regions) files.push([name, file]);
			if (ids !== undefined) files.push(['ids', ids]);
			if (changes !== undefined) files.push(['changes', changes]);
			for (const [key, value] of files) {
				if (
					(key !== 'index' && key !== 'ids' && key !== 'changes' && !isRegionFileName(key)) ||
					!isValidFile(key, value) ||
					!isOfWeek(key, value, pull)
				) {
					throw new FinderPackError('E_FINDER_PACK_BAD_INPUT');
				}
			}

			// The same bound the held week is judged by: a week this far ahead is a typo or an attack, not the next pull.
			if (isFarFuture(pull)) throw new FinderPackError('E_FINDER_PACK_BAD_INPUT');

			const epochAtStart = epoch;
			const dropAtStart = dropEpoch;
			let newer = true;
			await withKeystoreShared(async () => {
				const keystore = await readKeystoreRow(db);
				const rows = await Promise.all(
					files.map(([key, value]) => sealFile(keystore, key, pull, value))
				);
				await withPackLock(async () => {
					requireNotDropped(dropAtStart);
					// A held week dated far ahead is not a week the data can have reached: it cannot outrank a real one, so it is
					// treated as if nothing were held, and the real week replaces it.
					const onDisk = await readStoredIndex(keystore);
					const held = onDisk !== undefined && !isFarFuture(onDisk.pullDate) ? onDisk : undefined;
					if (isRollback(held?.pullDate, pull)) throw new FinderPackError('E_FINDER_PACK_ROLLBACK');
					newer = held === undefined || pull > held.pullDate;
					await withStores(db, PACK_STORE, 'readwrite', (tx) => {
						if (newer) for (const key of WEEK_KEYS) tx.objectStore(PACK_STORE).delete(key);
						putRows(tx, rows);
					});
				});
			});
			if (epoch !== epochAtStart) return;
			// "Newer" is judged against the disk, but the memo belongs to the week this tab holds: a peer tab may have moved the
			// disk on already, and then an older week's files are still here even though this swap only adds to the disk's week.
			if (newer || _index?.pullDate !== pull) clearMemo();
			else for (const [key] of files) memo.delete(key);
			_index = index;
		},

		/** Keep a supporting table (ZIP points, crosswalk); tables are kept across weeks. */
		async putTable(name: TableFileName, table: PackTable): Promise<void> {
			requireReady();
			if (!TABLE_FILE_NAMES.includes(name) || !TABLE_VALIDATORS[name](table).valid) {
				throw new FinderPackError('E_FINDER_PACK_BAD_INPUT');
			}
			const key: RowKey = `table:${name}`;
			const dropAtStart = dropEpoch;
			await withKeystoreShared(async () => {
				const row = await sealFile(await readKeystoreRow(db), key, undefined, table);
				await withPackLock(() => {
					requireNotDropped(dropAtStart);
					return withStores(db, PACK_STORE, 'readwrite', (tx) => putRows(tx, [row]));
				});
			});
			memo.delete(key);
		},

		/** Mark listings as opened; ids already marked are left as they are. */
		markOpened(ids: number[]): Promise<void> {
			return updateSeen((current) => {
				const have = setOf(current.finderSeen);
				const added = ids.filter((id, n) => !have.has(id) && ids.indexOf(id) === n);
				return added.length === 0
					? null
					: { ...current, finderSeen: [...current.finderSeen, ...added] };
			});
		},

		/** Replace the seen list with a pruned one (the caller drops ids no longer listed). */
		setSeen(ids: number[]): Promise<void> {
			return updateSeen((current) => ({ ...current, finderSeen: ids }));
		},

		/** Move the last-seen pull forward; an older or equal date changes nothing. */
		advanceLastSeen(pullDate: string): Promise<void> {
			if (!isIsoDate(pullDate))
				return Promise.reject(new FinderPackError('E_FINDER_PACK_BAD_INPUT'));
			return updateSeen((current) =>
				nextLastSeen(current.finderLastSeenPull, pullDate) === current.finderLastSeenPull
					? null
					: { ...current, finderLastSeenPull: pullDate }
			);
		},

		/** Register a callback for when everything decrypted is dropped (a relock or drop); returns the unsubscribe. */
		onDrop(fn: () => void): () => void {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},

		/** Sync relock for the pagehide/freeze handlers: drop every decrypted thing held. Never re-reads on its own. */
		relockSync(reason: RelockReason): void {
			lockState = nextLockState(lockState, reason);
			epoch++;
			_ready = false;
			_failed = false;
			clearHeld();
			notifyDropped();
		},

		/** Clear every row of the pack and everything in memory (a restore replaced the data, or the person removed it). */
		async drop(): Promise<void> {
			// Readiness is left as it was: a relock that landed before or during the wait stands, and a locked or failed
			// store needs a load() before it decrypts anything again.
			await withKeystoreShared(() =>
				withPackLock(() => {
					dropEpoch++;
					return withStores(db, PACK_STORE, 'readwrite', (tx) => {
						tx.objectStore(PACK_STORE).clear();
					});
				})
			);
			epoch++;
			clearHeld();
			notifyDropped();
		}
	};

	return api;
}

export type FinderPackStore = ReturnType<typeof createFinderPackStore>;
