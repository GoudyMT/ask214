import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFinderPackStore } from './pack-store.svelte';
import { createFinderStore } from './store.svelte';
import { bootstrapLocalKeystore } from '../../keystore/bootstrap';
import { openTestDb, deleteTestDb } from '../../db/_test-helpers';
import { withStores, reqToPromise } from '../../db/schema';
import { rotateOrUpgrade } from '../../db/locks';
import { encryptRecord, decryptRecord } from '../../crypto/record-crypto';
import { readKeystoreRow } from '../../profile/store.svelte';
import { cleanListing } from '../fixtures/clean';
import type { ChangesFile, IdsFile, IndexFile, RegionFile } from '../contract/listing';
import type { RegionFileName } from '../contract/places';
import type { ZipsTable } from '../contract/tables';

// A passthrough over the cipher that counts decrypts, so "decrypted again only when asked" can be shown. The path is a
// `$lib` alias on purpose: with a relative path the mock silently never applied to the store's own import in this
// browser runner.
const seams = vi.hoisted(() => ({ decrypts: 0 }));
vi.mock('$lib/crypto/record-crypto', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../crypto/record-crypto')>();
	return {
		...real,
		decryptRecord: (...args: Parameters<typeof real.decryptRecord>) => {
			seams.decrypts++;
			return real.decryptRecord(...args);
		}
	};
});

// Real Chromium (SubtleCrypto + IndexedDB + navigator.locks): the finder's data pack keeps each downloaded file as one
// encrypted row bound to its key and its week, and holds nothing decrypted once the app locks.

const WEEK_0 = '2026-10-07';
const WEEK_1 = '2026-10-14';
const WEEK_2 = '2026-10-21';
const ORG = 'Example Wind Services';
// The device clock, fixed late in the UTC day so the far-future bound is shown to count whole UTC days.
const NOW = Date.UTC(2026, 9, 22, 23, 59);
const makeStore = (database: IDBDatabase = db) => createFinderPackStore(database, () => NOW);

const region = (name: RegionFileName, pull: string, ids: number[]): RegionFile => ({
	v: 1,
	pullDate: pull,
	file: name,
	listings: ids.map((i) => cleanListing({ i, fl: pull }))
});

const indexFile = (pull: string, names: RegionFileName[]): IndexFile => ({
	v: 1,
	pullDate: pull,
	baseline: false,
	baselineDate: '2026-10-01',
	files: names.map((name) => ({ name, count: 1, bytes: 100 }))
});

const idsFile = (pull: string): IdsFile => ({
	v: 1,
	pullDate: pull,
	ids: [[1001, '2026-10-01']],
	aliases: []
});

const changesFile = (pull: string): ChangesFile => ({
	v: 1,
	weeks: [{ pullDate: pull, added: [1001], removed: [], newOrgs: [] }]
});

const zips: ZipsTable = { v: 1, rows: [['21046', 'MD', 39.2, -76.86]] };

/** A complete swap for one week: a region file per name, in the order given, with ids and changes. */
function week(pull: string, names: RegionFileName[], withExtras = true) {
	return {
		index: indexFile(pull, names),
		regions: new Map(names.map((name, n) => [name, region(name, pull, [1001 + n])])),
		...(withExtras ? { ids: idsFile(pull), changes: changesFile(pull) } : {})
	};
}

type Row = { id: string; rec: Uint8Array };
let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	seams.decrypts = 0;
});

afterEach(async () => {
	await deleteTestDb(db);
});

const allRows = () =>
	withStores(db, 'skillbridge-finder-pack', 'readonly', (tx) =>
		reqToPromise<Row[]>(tx.objectStore('skillbridge-finder-pack').getAll())
	);
const rowKeys = async () => (await allRows()).map((r) => r.id).sort();
const putRaw = (row: Row) =>
	withStores(db, 'skillbridge-finder-pack', 'readwrite', (tx) => {
		tx.objectStore('skillbridge-finder-pack').put(row);
	});
const getRaw = async (id: string) => (await allRows()).find((r) => r.id === id);

async function opened() {
	const store = makeStore();
	await store.load();
	return store;
}

const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
	Promise.race([
		p,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error('blocked')), ms))
	]);

describe('finder pack store', () => {
	it('is ready and empty when nothing has been fetched yet', async () => {
		const store = createFinderPackStore(db);
		expect(store.ready).toBe(false);
		await store.load();
		expect(store.ready).toBe(true);
		expect(store.failed).toBe(false);
		expect(store.pullDate).toBeUndefined();
		expect(store.index).toBeUndefined();
		expect(store.seen.size).toBe(0);
		expect(await store.readRegion('pacific')).toBeUndefined();
	});

	// The listings are public, but what a person fetched and when is theirs, and the device may be seized or shared.
	it('keeps one encrypted row per file: no listing text on disk, and each row reads back', async () => {
		const store = await opened();
		const input = week(WEEK_1, ['pacific', 'mountain']);
		await store.swap(input);

		expect(await rowKeys()).toEqual(['changes', 'ids', 'index', 'mountain', 'pacific']);
		for (const row of await allRows()) {
			const text = new TextDecoder('latin1').decode(row.rec);
			expect(text, row.id).not.toContain('Example');
			expect(text, row.id).not.toContain(ORG);
		}
		expect(await store.readRegion('pacific')).toEqual(input.regions.get('pacific'));
		expect(await store.readRegion('mountain')).toEqual(input.regions.get('mountain'));
		expect(await store.readIds()).toEqual(input.ids);
		expect(await store.readChanges()).toEqual(input.changes);
		expect(store.index).toEqual(input.index);
		expect(store.pullDate).toBe(WEEK_1);
		// A fresh store reads the same thing from disk.
		const again = await opened();
		expect(again.pullDate).toBe(WEEK_1);
		expect(await again.readRegion('pacific')).toEqual(input.regions.get('pacific'));
	});

	describe('a row can only be read where and when it was written', () => {
		it('a row copied to another key fails to read and returns nothing', async () => {
			const store = await opened();
			await store.swap(week(WEEK_1, ['pacific', 'mountain']));
			const pacific = await getRaw('pacific');
			await putRaw({ id: 'mountain', rec: pacific?.rec ?? new Uint8Array() });

			const fresh = await opened();
			await expect(fresh.readRegion('mountain')).rejects.toThrow('E_FINDER_PACK_BAD_ROW');
			expect(await fresh.readRegion('pacific')).toBeDefined();
		});

		// The row's binding to its week stops a row kept from last week, whatever its content.
		it.each([
			[
				'a region file',
				'pacific',
				(s: ReturnType<typeof createFinderPackStore>) => s.readRegion('pacific')
			],
			[
				'the changes file',
				'changes',
				(s: ReturnType<typeof createFinderPackStore>) => s.readChanges()
			]
		])('%s kept from an older week fails once the index has moved on', async (_n, key, read) => {
			const store = await opened();
			await store.swap(week(WEEK_1, ['pacific']));
			const stale = await getRaw(key);
			await store.swap(week(WEEK_2, ['mountain']));
			await putRaw({ id: key, rec: stale?.rec ?? new Uint8Array() });

			const fresh = await opened();
			expect(fresh.pullDate).toBe(WEEK_2);
			await expect(read(fresh)).rejects.toThrow('E_FINDER_PACK_BAD_ROW');
		});

		// A row that authenticates is not thereby safe to show: the files come from a server we do not control, and the
		// contract is checked on every read, not only when a file arrives.
		it('a row that decrypts but fails the contract is refused on read', async () => {
			const store = await opened();
			await store.swap(week(WEEK_1, ['pacific']));
			const bad = {
				...region('pacific', WEEK_1, [1001]),
				listings: [cleanListing({ i: 1001, z: '2104' })]
			};
			const rec = await encryptRecord(
				{ storeName: 'skillbridge-finder-pack', recordId: `pacific@${WEEK_1}`, schemaVersion: 1 },
				new TextEncoder().encode(JSON.stringify(bad)),
				await readKeystoreRow(db),
				0
			);
			await putRaw({ id: 'pacific', rec });

			await expect((await opened()).readRegion('pacific')).rejects.toThrow('E_FINDER_PACK_BAD_ROW');
		});

		// The row authenticates under its own key and week, so only the file's own content can show it is another week's.
		it('a changes file of another week planted under this week is refused on read', async () => {
			const store = await opened();
			await store.swap(week(WEEK_2, ['pacific']));
			const rec = await encryptRecord(
				{ storeName: 'skillbridge-finder-pack', recordId: `changes@${WEEK_2}`, schemaVersion: 1 },
				new TextEncoder().encode(JSON.stringify(changesFile(WEEK_1))),
				await readKeystoreRow(db),
				0
			);
			await putRaw({ id: 'changes', rec });

			await expect((await opened()).readChanges()).rejects.toThrow('E_FINDER_PACK_BAD_ROW');
		});
	});

	describe('a swap is whole or nothing', () => {
		const third: [string, (pull: string) => RegionFile][] = [
			[
				'a file that fails the contract',
				(p) => ({
					...region('remote', p, [1003]),
					listings: [cleanListing({ i: 1003, z: '2104' })]
				})
			],
			['a file of another pull date', () => region('remote', WEEK_0, [1003])],
			['a file that names another region', (p) => region('unknown', p, [1003])]
		];
		it.each(third)(
			'with %s as the third region throws and leaves the old set readable',
			async (_name, make) => {
				const store = await opened();
				const old = week(WEEK_1, ['pacific', 'mountain', 'remote']);
				await store.swap(old);
				const before = await allRows();

				const next = week(WEEK_2, ['pacific', 'mountain', 'remote']);
				next.regions.set('remote', make(WEEK_2));
				await expect(store.swap(next)).rejects.toThrow('E_FINDER_PACK_BAD_INPUT');

				expect(await allRows()).toEqual(before);
				expect(store.pullDate).toBe(WEEK_1);
				for (const name of ['pacific', 'mountain', 'remote'] as const) {
					expect(await store.readRegion(name), name).toEqual(old.regions.get(name));
				}
				expect(await store.readIds()).toEqual(old.ids);
			}
		);

		it('refuses an index, ids or changes file that fails the contract, writing nothing', async () => {
			const store = await opened();
			const bad = [
				{
					...week(WEEK_1, ['pacific']),
					index: { ...indexFile(WEEK_1, ['pacific']), baseline: 'yes' }
				},
				{ ...week(WEEK_1, ['pacific']), ids: { ...idsFile(WEEK_1), pullDate: WEEK_0 } },
				{ ...week(WEEK_1, ['pacific']), changes: { v: 1, weeks: [{ pullDate: 'soon' }] } },
				// A valid changes file that is not this week's, or says nothing about any week, is not this week's changes.
				{ ...week(WEEK_2, ['pacific']), changes: changesFile(WEEK_1) },
				{ ...week(WEEK_2, ['pacific']), changes: { v: 1, weeks: [] } }
			];
			for (const input of bad) {
				await expect(
					store.swap(input as unknown as Parameters<typeof store.swap>[0])
				).rejects.toThrow('E_FINDER_PACK_BAD_INPUT');
			}
			expect(await allRows()).toEqual([]);
			expect(store.pullDate).toBeUndefined();
		});
	});

	describe('weeks only move forward', () => {
		it('a rollback index throws and changes nothing', async () => {
			const store = await opened();
			await store.swap(week(WEEK_2, ['pacific']));
			const before = await allRows();

			await expect(store.swap(week(WEEK_1, ['pacific']))).rejects.toThrow('E_FINDER_PACK_ROLLBACK');
			expect(await allRows()).toEqual(before);
			expect(store.pullDate).toBe(WEEK_2);
		});

		it('a rollback is refused against the pack on disk, also for a tab that has not re-read', async () => {
			const stale = await opened();
			const peer = await opened();
			await peer.swap(week(WEEK_2, ['pacific']));
			await expect(stale.swap(week(WEEK_1, ['pacific']))).rejects.toThrow('E_FINDER_PACK_ROLLBACK');
			expect((await opened()).pullDate).toBe(WEEK_2);
		});

		it('an equal pull date adds its files and keeps the other held ones', async () => {
			const store = await opened();
			await store.swap(week(WEEK_1, ['pacific', 'mountain']));
			await store.swap({
				index: indexFile(WEEK_1, ['pacific', 'mountain', 'remote']),
				regions: new Map([['remote', region('remote', WEEK_1, [1009])]])
			});

			const fresh = await opened();
			for (const name of ['pacific', 'mountain', 'remote'] as const) {
				expect(await fresh.readRegion(name), name).toBeDefined();
			}
			expect(await fresh.readIds()).toEqual(idsFile(WEEK_1));
		});

		// A swap is "equal" against the disk, but newer than what this tab holds when a peer tab already moved the disk on.
		// The tab must not go on showing the older week's file it read before.
		it('a swap that is equal on disk but newer than the held week drops the older week from memory', async () => {
			const a = await opened();
			await a.swap(week(WEEK_1, ['pacific', 'mountain']));
			expect((await a.readRegion('pacific'))?.pullDate).toBe(WEEK_1);

			const b = await opened();
			await b.swap(week(WEEK_2, ['pacific']));
			await a.swap(week(WEEK_2, ['mountain']));

			expect(a.pullDate).toBe(WEEK_2);
			expect((await a.readRegion('pacific'))?.pullDate).toBe(WEEK_2);
		});

		it('a newer pull date removes every old-week file row and keeps seen and tables', async () => {
			const store = await opened();
			await store.swap(week(WEEK_1, ['pacific', 'mountain']));
			await store.putTable('zips', zips);
			await store.markOpened([1001]);

			await store.swap(week(WEEK_2, ['remote'], false));

			expect(await rowKeys()).toEqual(['index', 'remote', 'seen', 'table:zips']);
			const fresh = await opened();
			expect(fresh.pullDate).toBe(WEEK_2);
			expect([...fresh.seen]).toEqual([1001]);
			expect(await fresh.readTable('zips')).toEqual(zips);
			expect(await fresh.readRegion('pacific')).toBeUndefined();
			expect(await fresh.readIds()).toBeUndefined();
		});
	});

	// A pipeline year typo or a hostile deploy can publish an index dated far ahead; accepting it would make every real
	// week after it look like a rollback, with nothing but dropping the pack to recover.
	describe('a far-future index', () => {
		it('is refused when more than 7 days ahead of the device day, and accepted at exactly 7', async () => {
			const store = await opened();
			// NOW is 2026-10-22 in UTC, so 7 days ahead is 2026-10-29.
			for (const pull of ['2099-01-01', '2026-10-30']) {
				await expect(store.swap(week(pull, ['pacific']))).rejects.toThrow(
					'E_FINDER_PACK_BAD_INPUT'
				);
			}
			expect(await allRows()).toEqual([]);
			expect(store.pullDate).toBeUndefined();

			await store.swap(week('2026-10-29', ['pacific']));
			expect(store.pullDate).toBe('2026-10-29');
		});

		it('a held index dated far ahead does not make the real week a rollback', async () => {
			const keystore = await readKeystoreRow(db);
			const plant = async (id: string, recordId: string, value: unknown) =>
				putRaw({
					id,
					rec: await encryptRecord(
						{ storeName: 'skillbridge-finder-pack', recordId, schemaVersion: 1 },
						new TextEncoder().encode(JSON.stringify(value)),
						keystore,
						0
					)
				});
			await plant('index', 'index', indexFile('2099-01-01', ['pacific']));
			await plant('pacific', 'pacific@2099-01-01', region('pacific', '2099-01-01', [1001]));

			const store = await opened();
			expect(store.pullDate).toBe('2099-01-01');
			await store.swap(week(WEEK_2, ['mountain']));

			expect(store.pullDate).toBe(WEEK_2);
			// The hostile week's files are gone, not merged into the real week.
			expect(await rowKeys()).toEqual(['changes', 'ids', 'index', 'mountain']);
			expect((await opened()).pullDate).toBe(WEEK_2);
		});
	});

	// A peer tab moving to a newer week makes this tab's unread files fail their week binding. That is a tab that is behind,
	// not a damaged row, and a caller that answers a bad row by dropping the pack would wipe the person's opened ids.
	describe('a peer tab swapped to a newer week', () => {
		it('a read of a file not yet read says the week is stale, and a load catches up', async () => {
			const a = await opened();
			await a.swap(week(WEEK_1, ['pacific', 'mountain']));
			const b = await opened();
			await a.swap(week(WEEK_2, ['pacific', 'mountain']));

			await expect(b.readRegion('pacific')).rejects.toThrow('E_FINDER_PACK_STALE');
			await expect(b.readIds()).rejects.toThrow('E_FINDER_PACK_STALE');

			await b.load();
			expect(b.pullDate).toBe(WEEK_2);
			expect((await b.readRegion('pacific'))?.pullDate).toBe(WEEK_2);
		});
	});

	describe('tables', () => {
		it('are kept encrypted across weeks and refused when they fail the contract', async () => {
			const store = await opened();
			await store.putTable('zips', zips);
			const text = new TextDecoder('latin1').decode((await getRaw('table:zips'))?.rec);
			expect(text).not.toContain('21046');
			expect(await store.readTable('zips')).toEqual(zips);

			await expect(
				store.putTable('zips', { v: 1, rows: [['2104', 'MD', 1, 1]] } as ZipsTable)
			).rejects.toThrow('E_FINDER_PACK_BAD_INPUT');
			expect(await store.readTable('zips')).toEqual(zips);
			expect(await store.readTable('crosswalk')).toBeUndefined();
		});
	});

	describe('what the person has seen', () => {
		it('two tabs marking at once both land', async () => {
			const a = await opened();
			const b = await opened();
			await Promise.all([a.markOpened([1]), b.markOpened([2])]);

			const fresh = await opened();
			expect([...fresh.seen].sort()).toEqual([1, 2]);
		});

		// An older tab saving must not erase a key a newer release added to the row.
		it('marking an id keeps a key this release does not know', async () => {
			const keystore = await readKeystoreRow(db);
			const aad = { storeName: 'skillbridge-finder-pack', recordId: 'seen', schemaVersion: 1 };
			const rec = await encryptRecord(
				aad,
				new TextEncoder().encode(JSON.stringify({ finderSeen: [1], future: 'kept' })),
				keystore,
				0
			);
			await putRaw({ id: 'seen', rec });

			await (await opened()).markOpened([2]);

			const row = await getRaw('seen');
			const plain = await decryptRecord(aad, row?.rec ?? new Uint8Array(), keystore, 0);
			expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({
				finderSeen: [1, 2],
				future: 'kept'
			});
		});

		it('setSeen replaces the list with the pruned one, keeping the last-seen pull', async () => {
			const store = await opened();
			await store.markOpened([1, 2, 3]);
			await store.advanceLastSeen(WEEK_1);
			await store.setSeen([2]);
			const fresh = await opened();
			expect([...fresh.seen]).toEqual([2]);
			expect(fresh.lastSeenPull).toBe(WEEK_1);
		});

		it('the last-seen pull only moves forward', async () => {
			const store = await opened();
			await store.advanceLastSeen(WEEK_1);
			await store.advanceLastSeen(WEEK_0);
			expect(store.lastSeenPull).toBe(WEEK_1);
			await store.advanceLastSeen(WEEK_2);
			await store.advanceLastSeen(WEEK_2);
			await store.advanceLastSeen(WEEK_1);
			expect((await opened()).lastSeenPull).toBe(WEEK_2);
			await expect(store.advanceLastSeen('soon')).rejects.toThrow('E_FINDER_PACK_BAD_INPUT');
		});

		// The carried store's generation guards the person's saved programs; a seen mark must never raise it.
		it('leaves the finder record and its marker untouched', async () => {
			const finder = createFinderStore(db);
			await finder.load();
			await finder.setSetup({ radius: 25 });
			const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b));
			const marker = () =>
				withStores(db, 'skillbridge-finder-hwm', 'readonly', (tx) =>
					reqToPromise<{ payload: unknown; mac: ArrayBuffer }>(
						tx.objectStore('skillbridge-finder-hwm').get(0)
					)
				);
			const body = () =>
				withStores(db, 'skillbridge-finder', 'readonly', (tx) =>
					reqToPromise<Row>(tx.objectStore('skillbridge-finder').get(0))
				);
			const before = { m: await marker(), b: await body() };

			const store = await opened();
			await store.markOpened([5]);
			await store.advanceLastSeen(WEEK_1);
			await store.setSeen([5, 6]);
			await store.swap(week(WEEK_1, ['pacific']));

			const after = { m: await marker(), b: await body() };
			expect(after.m.payload).toEqual(before.m.payload);
			expect(hex(after.m.mac)).toEqual(hex(before.m.mac));
			expect(after.b).toEqual(before.b);
		});
	});

	// The profile-write lock times out at 10 s and every profile save queues behind it, so multi-MB files must never wait
	// on it or hold it.
	it('never takes the profile-write lock: load, swap, read and mark complete while another holder has it', async () => {
		const setup = await opened();
		await setup.swap(week(WEEK_1, ['pacific']));

		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const acquired = new Promise<void>((resolve) => {
			void navigator.locks.request('profile-write', { mode: 'exclusive' }, () => {
				resolve();
				return held;
			});
		});
		await acquired;
		try {
			const store = makeStore();
			await within(2000, store.load());
			expect(await within(2000, store.readRegion('pacific'))).toBeDefined();
			await within(2000, store.swap(week(WEEK_2, ['mountain'])));
			await within(2000, store.markOpened([1001]));
			await within(2000, store.putTable('zips', zips));
			expect([...store.seen]).toEqual([1001]);
		} finally {
			release();
		}
	});

	// Erase holds the keystore lock exclusively so it is the last writer: a swap that began before it must not land its rows
	// into a database the person was told is empty.
	it('waits for an erase that holds the keystore lock, and writes only after it', async () => {
		const store = await opened();
		let landed = false;
		let swapping: Promise<void> = Promise.resolve();
		await rotateOrUpgrade(async () => {
			swapping = store.swap(week(WEEK_1, ['pacific'])).then(() => {
				landed = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(landed).toBe(false);
			expect(await allRows()).toEqual([]);
		});
		await swapping;
		expect(landed).toBe(true);
	});

	describe('a failed load', () => {
		it.each([['index'], ['seen']])(
			'a %s row that does not decrypt: failed, nothing held, drop recovers',
			async (key) => {
				const setup = await opened();
				await setup.swap(week(WEEK_1, ['pacific']));
				await setup.markOpened([1]);
				const row = await getRaw(key);
				const bad = new Uint8Array(row?.rec ?? new Uint8Array());
				bad[20] = (bad[20] ?? 0) ^ 0xff;
				await putRaw({ id: key, rec: bad });

				const store = makeStore();
				await expect(store.load()).rejects.toThrow('E_FINDER_PACK_BAD_ROW');
				expect(store.ready).toBe(false);
				expect(store.failed).toBe(true);
				expect(store.index).toBeUndefined();
				expect(store.seen.size).toBe(0);

				await store.drop();
				await store.load();
				expect(store.ready).toBe(true);
				expect(store.failed).toBe(false);
			}
		);
	});

	describe('relock', () => {
		it('drops everything held, tells the listeners, and refuses reads and writes until a load', async () => {
			const store = await opened();
			await store.swap(week(WEEK_1, ['pacific']));
			await store.markOpened([1]);
			await store.advanceLastSeen(WEEK_1);
			await store.putTable('zips', zips);
			const dropped = vi.fn();
			const unsubscribed = vi.fn();
			store.onDrop(dropped);
			store.onDrop(unsubscribed)();

			store.relockSync('user');

			expect(store.ready).toBe(false);
			expect(store.pullDate).toBeUndefined();
			expect(store.index).toBeUndefined();
			expect(store.seen.size).toBe(0);
			expect(store.lastSeenPull).toBeUndefined();
			expect(dropped).toHaveBeenCalledTimes(1);
			expect(unsubscribed).not.toHaveBeenCalled();
			await expect(store.readRegion('pacific')).rejects.toThrow('E_FINDER_PACK_RELOCKED');
			const before = await allRows();
			const writes = [
				() => store.markOpened([2]),
				() => store.setSeen([2]),
				() => store.advanceLastSeen(WEEK_2),
				() => store.putTable('crosswalk', { v: 1, rows: [] }),
				() => store.swap(week(WEEK_2, ['mountain']))
			];
			for (const write of writes) await expect(write()).rejects.toThrow('E_FINDER_PACK_RELOCKED');
			expect(await allRows()).toEqual(before);
		});

		it('a listener that throws does not stop the others', async () => {
			const store = await opened();
			const later = vi.fn();
			store.onDrop(() => {
				throw new Error('listener');
			});
			store.onDrop(later);
			store.relockSync('idle');
			expect(later).toHaveBeenCalledTimes(1);
		});

		it('decrypts a file once while held, and again only after a relock and a new load', async () => {
			const store = await opened();
			await store.swap(week(WEEK_1, ['pacific']));
			const fresh = await opened();
			seams.decrypts = 0;
			await fresh.readRegion('pacific');
			await fresh.readRegion('pacific');
			expect(seams.decrypts).toBe(1);

			fresh.relockSync('hygiene');
			await fresh.load();
			seams.decrypts = 0;
			await fresh.readRegion('pacific');
			expect(seams.decrypts).toBe(1);
		});

		it('a read already in flight when the lock lands returns nothing and holds nothing', async () => {
			const store = await opened();
			await store.swap(week(WEEK_1, ['pacific']));
			const fresh = await opened();

			const inFlight = fresh.readRegion('pacific');
			fresh.relockSync('user');
			await expect(inFlight).rejects.toThrow('E_FINDER_PACK_RELOCKED');

			// Had the late read filled the memo, the next read after a load would not decrypt.
			await fresh.load();
			seams.decrypts = 0;
			await fresh.readRegion('pacific');
			expect(seams.decrypts).toBe(1);
		});

		describe('an automatic re-read (refresh)', () => {
			afterEach(() => {
				vi.restoreAllMocks();
			});

			// Idle or Lock: the person's presence lapsed, and a re-read on the next page event would reverse that.
			it('does not undo a lock the user or the idle timer asked for', async () => {
				const store = await opened();
				await store.markOpened([1]);
				store.relockSync('idle');
				expect(store.locked).toBe(true);
				seams.decrypts = 0;

				await store.refresh();

				expect(store.ready).toBe(false);
				expect(store.seen.size).toBe(0);
				expect(seams.decrypts).toBe(0);

				// Only the person's own load opens it again.
				await store.load();
				expect(store.locked).toBe(false);
				expect(store.ready).toBe(true);
				expect([...store.seen]).toEqual([1]);
			});

			// Page hygiene is the app tidying up on the way out; coming back owes the re-read, and a hide does not lock.
			it('re-reads a store that only page hygiene evicted', async () => {
				const store = await opened();
				await store.swap(week(WEEK_1, ['pacific']));
				await store.markOpened([1]);
				store.relockSync('hygiene');
				expect(store.locked).toBe(false);
				seams.decrypts = 0;

				await store.refresh();

				expect(store.ready).toBe(true);
				expect(store.pullDate).toBe(WEEK_1);
				expect([...store.seen]).toEqual([1]);
				expect(seams.decrypts).toBe(2);
			});

			it('a later hygiene relock does not turn a lock into an eviction', async () => {
				const store = await opened();
				store.relockSync('user');
				store.relockSync('hygiene');
				expect(store.locked).toBe(true);
				await store.refresh();
				expect(store.ready).toBe(false);
			});

			it('does not decrypt while the page is hidden, and reads again once it is visible', async () => {
				const store = await opened();
				await store.markOpened([1]);
				store.relockSync('hygiene');
				seams.decrypts = 0;

				const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
				await store.refresh();
				expect(seams.decrypts).toBe(0);
				expect(store.ready).toBe(false);

				visibility.mockReturnValue('visible');
				await store.refresh();
				expect(store.ready).toBe(true);
				expect([...store.seen]).toEqual([1]);
			});
		});

		it('a load already in flight when the lock lands does not bring the index back', async () => {
			const store = await opened();
			await store.swap(week(WEEK_1, ['pacific']));
			const fresh = makeStore();
			const loading = fresh.load();
			fresh.relockSync('user');
			await loading;
			expect(fresh.ready).toBe(false);
			expect(fresh.pullDate).toBeUndefined();
		});
	});

	// A drop waits for its locks; a relock that lands meanwhile (or came before) must not be undone by it, or a locked
	// device would decrypt again without a load.
	it('drop does not reopen a store that was relocked', async () => {
		const store = await opened();
		await store.swap(week(WEEK_1, ['pacific']));
		await store.putTable('zips', zips);
		store.relockSync('user');

		await store.drop();

		expect(store.ready).toBe(false);
		await expect(store.markOpened([7])).rejects.toThrow('E_FINDER_PACK_RELOCKED');
		await expect(store.readTable('zips')).rejects.toThrow('E_FINDER_PACK_RELOCKED');
	});

	// The person removed the pack and was told it was gone; a write that was already on its way must not put the week or
	// the opened ids back for the next load to read.
	it('a write that was under way when drop ran does not land after it', async () => {
		const store = await opened();
		await store.swap(week(WEEK_1, ['pacific']));
		await store.markOpened([1001]);

		const writes = [
			store.swap(week(WEEK_2, ['mountain'])),
			store.markOpened([1002]),
			store.putTable('zips', zips)
		];
		await store.drop();
		const settled = await Promise.allSettled(writes);

		expect(await allRows()).toEqual([]);
		// A write that won the race to the lock was cleared by the drop; one that lost it says so.
		for (const result of settled) {
			if (result.status === 'rejected') {
				expect((result.reason as Error).message).toBe('E_FINDER_PACK_RELOCKED');
			}
		}
		expect((await opened()).pullDate).toBeUndefined();
	});

	it('drop empties the store and memory, and tells the listeners', async () => {
		const store = await opened();
		await store.swap(week(WEEK_1, ['pacific']));
		await store.putTable('zips', zips);
		await store.markOpened([1]);
		const dropped = vi.fn();
		store.onDrop(dropped);

		await store.drop();

		expect(await allRows()).toEqual([]);
		expect(store.pullDate).toBeUndefined();
		expect(store.seen.size).toBe(0);
		expect(dropped).toHaveBeenCalledTimes(1);
		expect(await store.readRegion('pacific')).toBeUndefined();
		// Empty is a state the pack can be filled from again.
		await store.swap(week(WEEK_1, ['mountain']));
		expect(store.pullDate).toBe(WEEK_1);
	});
});
