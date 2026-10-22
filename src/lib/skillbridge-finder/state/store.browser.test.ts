import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFinderStore, FinderRelockedError, type FinderBroadcastEvent } from './store.svelte';
import { encryptFinderRecord } from './crypto-boundary';
import { MAX_COMPARE, MAX_SAVED, type FinderRecord } from './types';
import {
	KeystoreHmacMismatchError,
	KeystoreNotInitializedError,
	OccConflictError,
	readKeystoreRow
} from '../../profile/store.svelte';
import { wipeAllStores } from '../../db/wipe';
import { SidecarTamperError, signSidecar } from '../../profile/sidecars';
import { bootstrapLocalKeystore } from '../../keystore/bootstrap';
import { openTestDb, deleteTestDb } from '../../db/_test-helpers';
import { withStores, reqToPromise, type StoreName } from '../../db/schema';
import type { Listing } from '../contract/listing';

// A passthrough over the cipher that counts decrypts, so a re-read that must not happen can be shown not to. The path is
// a `$lib` alias on purpose: with a relative path the mock silently never applied to the store's own import in this
// browser runner.
const seams = vi.hoisted(() => ({ decrypts: 0, onEncrypt: null as (() => void) | null }));
vi.mock('$lib/crypto/record-crypto', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../crypto/record-crypto')>();
	return {
		...real,
		// Lets a test act in the middle of a save, after the store has checked it may write and before the row lands.
		encryptRecord: (...args: Parameters<typeof real.encryptRecord>) => {
			seams.onEncrypt?.();
			return real.encryptRecord(...args);
		},
		decryptRecord: (...args: Parameters<typeof real.decryptRecord>) => {
			seams.decrypts++;
			return real.decryptRecord(...args);
		}
	};
});

// Real Chromium (SubtleCrypto + IndexedDB + navigator.locks): the finder store keeps the person's place, saved programs,
// compare picks and filters encrypted, on the same load / save / OCC / relock spine as the calendar settings.

const TODAY = '2026-10-21';

function listing(i: number): Listing {
	return {
		i,
		o: 297,
		n: 'Example Training Co',
		p: 'Field Technician Internship',
		m: 1,
		b: ['Navy'],
		ind: ['Legal'],
		dib: true,
		dc: '2026-07-24',
		fl: TODAY
	};
}

type Row = { id: number; rec: Uint8Array };

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	seams.decrypts = 0;
	seams.onEncrypt = null;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await deleteTestDb(db);
});

const readRow = <T>(store: StoreName) =>
	withStores(db, store, 'readonly', (tx) =>
		reqToPromise<T | undefined>(tx.objectStore(store).get(0))
	);

const putRow = (store: StoreName, value: Record<string, unknown>) =>
	withStores(db, store, 'readwrite', (tx) => {
		tx.objectStore(store).put(value);
	});

/** A record a previous session left on the device: the body and its signed marker, at generation 1. */
async function seed(record: FinderRecord): Promise<void> {
	const ks = await readKeystoreRow(db);
	const rec = await encryptFinderRecord(record, ks, 1);
	const hwm = await signSidecar(
		'skillbridge-finder-hwm',
		{
			generation: 1,
			keystoreGeneration: ks.keystoreGeneration,
			epoch: ks.epoch,
			ts: 1716700000000
		},
		ks.hmacKeyRef
	);
	await putRow('skillbridge-finder', { id: 0, rec });
	await putRow('skillbridge-finder-hwm', { id: 0, ...hwm });
}

const EMPTY_RECORD: FinderRecord = { schemaVersion: 1, finderSaved: [], finderCompare: [] };

async function loaded(opts?: Parameters<typeof createFinderStore>[1]) {
	const store = createFinderStore(db, opts);
	await store.load();
	return store;
}

describe('finder store', () => {
	it('is ready with empty defaults before anything is saved (generation 0, no marker yet)', async () => {
		const store = createFinderStore(db);
		expect(store.ready).toBe(false);
		await store.load();
		expect(store.ready).toBe(true);
		expect(store.setup).toEqual({});
		expect(store.filters).toEqual({});
		expect(store.saved).toEqual([]);
		expect(store.compare).toEqual([]);
	});

	it('keeps place, filters, saved programs and compare picks across store instances', async () => {
		const a = await loaded();
		await a.setSetup({ place: { kind: 'zip', zip: '21046' }, radius: 50 });
		await a.setFilters({ branches: ['Navy'], delivery: [1, 3] });
		await a.save(listing(386), TODAY);
		await a.addCompare(386);

		const b = await loaded();
		expect(b.setup).toEqual({ place: { kind: 'zip', zip: '21046' }, radius: 50 });
		expect(b.filters).toEqual({ branches: ['Navy'], delivery: [1, 3] });
		expect(b.saved).toEqual([{ id: 386, savedOn: TODAY, facts: listing(386) }]);
		expect(b.compare).toEqual([386]);
	});

	// The body holds the person's place and picks: nothing readable may sit on disk.
	it('writes ciphertext only, with no readable ZIP in either store', async () => {
		const a = await loaded();
		await a.setSetup({ place: { kind: 'zip', zip: '21046' } });
		const body = await readRow<Row>('skillbridge-finder');
		const hwm = await readRow<Record<string, unknown>>('skillbridge-finder-hwm');
		const raw = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
		expect(raw(body?.rec ?? new Uint8Array())).not.toContain('21046');
		expect(JSON.stringify(hwm?.payload)).not.toContain('21046');
		expect(Object.keys((hwm?.payload ?? {}) as object).sort()).toEqual([
			'epoch',
			'generation',
			'keystoreGeneration',
			'ts'
		]);
	});

	describe('fails closed on a store it cannot trust', () => {
		it('a keystore whose record HMAC no longer verifies', async () => {
			const ks = await readRow<Record<string, unknown>>('keystore');
			await putRow('keystore', { ...ks, keystoreGeneration: 7 });
			const store = createFinderStore(db);
			await expect(store.load()).rejects.toThrow(KeystoreHmacMismatchError);
			expect(store.ready).toBe(false);
			expect(store.failed).toBe(true);
		});

		it('a marker whose signature is wrong', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			const hwm = await readRow<{ mac: ArrayBuffer }>('skillbridge-finder-hwm');
			const mac = new Uint8Array(hwm?.mac ?? new ArrayBuffer(0)).slice();
			mac[0] = (mac[0] ?? 0) ^ 0xff;
			await putRow('skillbridge-finder-hwm', { ...hwm, mac: mac.buffer });

			const b = createFinderStore(db);
			await expect(b.load()).rejects.toThrow(SidecarTamperError);
			expect(b.ready).toBe(false);
			expect(b.failed).toBe(true);
		});

		// A marker with no body is a deleted record, not a new install: reading it as empty would let the next save
		// quietly replace what the person had.
		it('a marker present but the body missing', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			await withStores(db, 'skillbridge-finder', 'readwrite', (tx) => {
				tx.objectStore('skillbridge-finder').clear();
			});

			const b = createFinderStore(db);
			await expect(b.load()).rejects.toThrow('E_FINDER_BODY_MISSING');
			expect(b.ready).toBe(false);
			expect(b.failed).toBe(true);
		});

		it('a body that does not decrypt, and reads as ready again once it does', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			const good = await readRow<Row>('skillbridge-finder');
			const bad = new Uint8Array(good?.rec ?? new Uint8Array());
			bad[20] = (bad[20] ?? 0) ^ 0xff;
			await putRow('skillbridge-finder', { id: 0, rec: bad });

			const b = createFinderStore(db);
			expect(b.failed).toBe(false);
			await expect(b.load()).rejects.toThrow();
			expect(b.failed).toBe(true);

			await putRow('skillbridge-finder', { id: 0, rec: good?.rec });
			await b.load();
			expect(b.failed).toBe(false);
			expect(b.ready).toBe(true);
			expect(b.setup).toEqual({ radius: 25 });
		});

		// A read that fails after a peer's save must not leave this tab holding the older record as if it were current,
		// nor let a write from it lay that record over the peer's.
		it('a re-read that fails after a peer saved: not ready, empty, and a write is refused', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			const peer = await loaded();
			await peer.setSetup({ radius: 100 });
			const good = await readRow<Row>('skillbridge-finder');
			const bad = new Uint8Array(good?.rec ?? new Uint8Array());
			bad[20] = (bad[20] ?? 0) ^ 0xff;
			await putRow('skillbridge-finder', { id: 0, rec: bad });

			await expect(a.refresh()).rejects.toThrow();
			expect(a.ready).toBe(false);
			expect(a.setup).toEqual({});
			await putRow('skillbridge-finder', { id: 0, rec: good?.rec });
			await expect(a.setSetup({ radius: 50 })).rejects.toThrow(OccConflictError);

			const fresh = await loaded();
			expect(fresh.setup).toEqual({ radius: 100 });
		});
	});

	describe('concurrent writers', () => {
		it('a stale tab write throws and does not land', async () => {
			const a = await loaded();
			const b = await loaded(); // both at generation 0
			await a.setSetup({ radius: 25 });
			await expect(b.setSetup({ radius: 100 })).rejects.toThrow(OccConflictError);

			const fresh = await loaded();
			expect(fresh.setup).toEqual({ radius: 25 });
		});

		// Fired without awaiting: each change must be built on the record the one before it left, inside the write lock,
		// or the later write drops the earlier one's field.
		it('merges quick changes of different kinds against the current record', async () => {
			const a = await loaded();
			await Promise.all([
				a.setSetup({ radius: 50 }),
				a.save(listing(386), TODAY),
				a.addCompare(386),
				a.setFilters({ kinds: ['internship'] })
			]);

			const b = await loaded();
			expect(b.setup).toEqual({ radius: 50 });
			expect(b.saved.map((s) => s.id)).toEqual([386]);
			expect(b.compare).toEqual([386]);
			expect(b.filters).toEqual({ kinds: ['internship'] });
		});

		it('applies quick updates of one kind in order to the record as saved', async () => {
			const a = await loaded();
			await Promise.all([
				a.setSetup((cur) => ({ ...cur, territories: true })),
				a.setSetup((cur) => ({ ...cur, overseas: true }))
			]);
			const b = await loaded();
			expect(b.setup).toEqual({ territories: true, overseas: true });
		});

		it('two tabs that each re-read before saving both land', async () => {
			const a = await loaded();
			const b = await loaded();
			await a.save(listing(386), TODAY);
			await b.refresh();
			await b.save(listing(412), TODAY);

			const fresh = await loaded();
			expect(fresh.saved.map((s) => s.id)).toEqual([386, 412]);
		});
	});

	describe('the caps are checked on the record as it stands', () => {
		const picks = (ids: number[]): FinderRecord => ({ ...EMPTY_RECORD, finderCompare: ids });

		// Checked inside the lock on the current record, not on what this tab saw when the button was drawn.
		it('one tab firing two adds together on two picks: one lands, the other is refused as full', async () => {
			await seed(picks([1, 2]));
			const a = await loaded();
			const results = await Promise.allSettled([a.addCompare(3), a.addCompare(4)]);

			expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
			expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
				message: 'E_FINDER_COMPARE_FULL'
			});
			const fresh = await loaded();
			expect(fresh.compare).toEqual([1, 2, 3]);
		});

		it('two tabs adding the last pick at once: exactly one lands and the record holds three', async () => {
			await seed(picks([1, 2]));
			const a = await loaded();
			const b = await loaded();
			const results = await Promise.allSettled([a.addCompare(3), b.addCompare(4)]);

			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
			const fresh = await loaded();
			expect(fresh.compare).toHaveLength(MAX_COMPARE);
		});

		it('a tab that re-read before adding is refused for being full, not for being stale', async () => {
			await seed(picks([1, 2]));
			const a = await loaded();
			const b = await loaded();
			await a.addCompare(3);
			await b.refresh();
			await expect(b.addCompare(4)).rejects.toThrow('E_FINDER_COMPARE_FULL');
			expect(b.compare).toEqual([1, 2, 3]);
		});

		it('adding a pick already held changes nothing, also when full', async () => {
			await seed(picks([1, 2, 3]));
			const a = await loaded();
			await a.addCompare(2);
			expect(a.compare).toEqual([1, 2, 3]);
		});

		it('saving at the cap is refused for a new program, and a program already saved is not', async () => {
			const full = Array.from({ length: MAX_SAVED }, (_, n) => ({
				id: n + 1,
				savedOn: TODAY,
				facts: listing(n + 1)
			}));
			await seed({ ...EMPTY_RECORD, finderSaved: full });
			const a = await loaded();
			expect(a.saved).toHaveLength(MAX_SAVED);

			await expect(a.save(listing(MAX_SAVED + 1), TODAY)).rejects.toThrow('E_FINDER_SAVED_FULL');
			await a.save(listing(5), TODAY);
			expect(a.saved).toHaveLength(MAX_SAVED);
			const fresh = await loaded();
			expect(fresh.saved).toHaveLength(MAX_SAVED);
		});
	});

	describe('saved programs and compare picks', () => {
		it('saving a program twice keeps the first save, without writing again', async () => {
			const events: FinderBroadcastEvent[] = [];
			const a = await loaded({ onBroadcast: (e) => events.push(e) });
			await a.save(listing(386), '2026-10-01');
			await a.save(listing(386), '2026-10-20');

			expect(a.saved).toEqual([{ id: 386, savedOn: '2026-10-01', facts: listing(386) }]);
			expect(events).toEqual([{ type: 'skillbridge-finder-updated' }]);
		});

		it('unsave, removeCompare and clearCompare take their entries out, on disk', async () => {
			const a = await loaded();
			await a.save(listing(1), TODAY);
			await a.save(listing(2), TODAY);
			await a.addCompare(1);
			await a.addCompare(2);
			await a.unsave(1);
			await a.removeCompare(2);

			const b = await loaded();
			expect(b.saved.map((s) => s.id)).toEqual([2]);
			expect(b.compare).toEqual([1]);

			await b.clearCompare();
			expect((await loaded()).compare).toEqual([]);
		});

		// Whatever the store writes must read back: a record it cannot decode would lock the person out of their own saves.
		it('refuses a change the stored record could not be read back from, and writes nothing', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			await expect(a.setSetup({ place: { kind: 'zip', zip: '2104' } })).rejects.toThrow(
				'E_FINDER_BAD_SETUP'
			);
			await expect(a.save({ ...listing(5), z: '2104' }, TODAY)).rejects.toThrow(
				'E_FINDER_BAD_SAVED'
			);
			await expect(a.save(listing(5), 'yesterday')).rejects.toThrow('E_FINDER_BAD_SAVED');

			const fresh = await loaded();
			expect(fresh.setup).toEqual({ radius: 25 });
			expect(fresh.saved).toEqual([]);
			// The failed writes did not move the generation: this tab can still save.
			await a.setSetup({ radius: 50 });
			expect((await loaded()).setup).toEqual({ radius: 50 });
		});
	});

	describe('relock, user lock and Erase', () => {
		it('relockSync drops the decrypted record: not ready, empty getters, the record stays on disk', async () => {
			const a = await loaded();
			await a.save(listing(386), TODAY);
			await a.addCompare(386);
			a.relockSync('idle');

			expect(a.ready).toBe(false);
			expect(a.setup).toEqual({});
			expect(a.filters).toEqual({});
			expect(a.saved).toEqual([]);
			expect(a.compare).toEqual([]);
			expect((await loaded()).compare).toEqual([386]);
		});

		// _generation is deliberately not reset by a relock, so the conflict check alone cannot catch a write built from
		// nothing, and it would lay defaults over the person's real record.
		it('refuses every write while relocked, and the record on disk is intact', async () => {
			const a = await loaded();
			await a.save(listing(386), TODAY);
			a.relockSync('user');

			const writes = [
				() => a.setSetup({ radius: 25 }),
				() => a.setFilters({ kinds: ['other'] }),
				() => a.save(listing(2), TODAY),
				() => a.unsave(386),
				() => a.addCompare(386),
				() => a.removeCompare(386),
				() => a.clearCompare()
			];
			for (const write of writes) await expect(write()).rejects.toThrow(FinderRelockedError);

			const fresh = await loaded();
			expect(fresh.saved.map((s) => s.id)).toEqual([386]);
			expect(fresh.setup).toEqual({});
			expect(fresh.compare).toEqual([]);
		});

		// The lock cannot be undone by a save that was already under way: its row lands (the edit is not lost), but the
		// decrypted record does not come back into a tab that has since locked.
		it('a lock that lands during a save stays locked, and the save still lands', async () => {
			const a = await loaded();
			seams.onEncrypt = () => a.relockSync('user');
			await a.setSetup({ radius: 25 });

			expect(a.ready).toBe(false);
			expect(a.locked).toBe(true);
			expect((await loaded()).setup).toEqual({ radius: 25 });
		});

		// Erase clears every store through wipeAllStores, never through this store. A second tab that loaded the record before
		// it must not put the record back, while the device has no keys or once the person has set it up again.
		it('after Erase the finder rows are gone, and a tab that loaded before it cannot write', async () => {
			const a = await loaded();
			await a.save(listing(386), TODAY);

			await wipeAllStores(db);

			expect(await readRow('skillbridge-finder')).toBeUndefined();
			expect(await readRow('skillbridge-finder-hwm')).toBeUndefined();
			await expect(a.setSetup({ radius: 25 })).rejects.toThrow(KeystoreNotInitializedError);
			await bootstrapLocalKeystore(db);
			await expect(a.setSetup({ radius: 25 })).rejects.toThrow(OccConflictError);
			expect(await readRow('skillbridge-finder')).toBeUndefined();
			expect(await readRow('skillbridge-finder-hwm')).toBeUndefined();
			const fresh = await loaded();
			expect(fresh.saved).toEqual([]);
			expect(fresh.setup).toEqual({});
		});

		// The idle lock and the user's Lock are the user's: an automatic re-read must not reverse them.
		it('refresh after a user lock does not decrypt or open the store; load, the user asking, does', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			a.relockSync('user');
			seams.decrypts = 0;

			await a.refresh();
			expect(seams.decrypts).toBe(0);
			expect(a.ready).toBe(false);
			expect(a.locked).toBe(true);

			a.relockSync('hygiene');
			expect(a.locked).toBe(true);
			await a.load();
			expect(seams.decrypts).toBe(1);
			expect(a.locked).toBe(false);
			expect(a.setup).toEqual({ radius: 25 });
		});

		it('page hygiene alone is not the user lock, and a refresh puts the record back', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			a.relockSync('hygiene');
			expect(a.ready).toBe(false);
			expect(a.locked).toBe(false);

			await a.refresh();
			expect(a.ready).toBe(true);
			expect(a.setup).toEqual({ radius: 25 });
		});

		it('does not decrypt on a refresh while the page is hidden', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			a.relockSync('hygiene');
			seams.decrypts = 0;

			const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
			await a.refresh();
			expect(seams.decrypts).toBe(0);
			expect(a.ready).toBe(false);

			visibility.mockReturnValue('visible');
			await a.refresh();
			expect(seams.decrypts).toBe(1);
			expect(a.ready).toBe(true);
		});

		it('a lock that lands during an Unlock read wins: the store stays locked, neither failed nor ready', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			a.relockSync('user');

			const unlock = a.load();
			a.relockSync('hygiene');
			await unlock;

			expect(a.locked).toBe(true);
			expect(a.failed).toBe(false);
			expect(a.ready).toBe(false);
		});

		it('a user Unlock clears a past failure while it runs', async () => {
			const a = await loaded();
			await a.setSetup({ radius: 25 });
			const good = await readRow<Row>('skillbridge-finder');
			const bad = new Uint8Array(good?.rec ?? new Uint8Array());
			bad[20] = (bad[20] ?? 0) ^ 0xff;
			await putRow('skillbridge-finder', { id: 0, rec: bad });
			const b = createFinderStore(db);
			await expect(b.load()).rejects.toThrow();
			expect(b.failed).toBe(true);
			await putRow('skillbridge-finder', { id: 0, rec: good?.rec });

			b.relockSync('user');
			const retry = b.load();
			expect(b.failed).toBe(false);
			await retry;
			expect(b.ready).toBe(true);
		});
	});

	describe('broadcasts', () => {
		it('tells the other tabs after a save, and not when the save failed', async () => {
			const events: FinderBroadcastEvent[] = [];
			const a = await loaded({ onBroadcast: (e) => events.push(e) });
			await a.setSetup({ radius: 25 });
			await expect(a.setSetup({ place: { kind: 'zip', zip: 'x' } })).rejects.toThrow();
			expect(events).toEqual([{ type: 'skillbridge-finder-updated' }]);
		});

		it('a non-hygiene relock broadcasts its reason', async () => {
			const events: FinderBroadcastEvent[] = [];
			const store = createFinderStore(db, { onBroadcast: (e) => events.push(e) });

			store.relockSync('idle');
			store.relockSync('user');
			store.relockSync('peer');
			store.relockSync('hygiene');

			expect(events).toEqual([
				{ type: 'relocked', reason: 'idle' },
				{ type: 'relocked', reason: 'user' },
				{ type: 'relocked' }
			]);
			expect('reason' in (events[2] ?? { reason: 1 })).toBe(false);
		});
	});
});
