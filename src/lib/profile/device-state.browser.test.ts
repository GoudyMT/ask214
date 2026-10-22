import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { withStores, reqToPromise } from '../db/schema';
import { readDeviceState } from './device-state';
import { signSidecar, type ProfileHwmPayload } from './sidecars';
import { createProfileStore } from './store.svelte';

type Store =
	| 'keystore'
	| 'profile-hwm'
	| 'profile'
	| 'timeline-state-hwm'
	| 'calendar-sync-hwm'
	| 'skillbridge-finder-hwm';
type Row = Record<string, unknown>;

// zeroizeRecord records every record the read discards, so a test can show the decoded profile was wiped. The path
// is a `$lib` alias on purpose: with a relative path the mock silently never applied in this browser runner.
const seams = vi.hoisted(() => ({ zeroized: [] as Record<string, unknown>[] }));

vi.mock('$lib/profile/lifecycle', async (importOriginal) => {
	const real = await importOriginal<typeof import('./lifecycle')>();
	return {
		...real,
		zeroizeRecord: (rec: Record<string, unknown>): void => {
			seams.zeroized.push(rec);
			real.zeroizeRecord(rec);
		}
	};
});

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	seams.zeroized.length = 0;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await deleteTestDb(db);
});

function readRow(store: Store): Promise<Row | undefined> {
	return withStores(db, store, 'readonly', (tx) =>
		reqToPromise<Row | undefined>(tx.objectStore(store).get(0))
	);
}

function putRow(store: Store, value: Row): Promise<void> {
	return withStores(db, store, 'readwrite', (tx) => {
		tx.objectStore(store).put(value);
	});
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const allZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

function need<T>(v: T | null | undefined): T {
	if (v === null || v === undefined) throw new Error('test setup: missing value');
	return v;
}

describe('readDeviceState', () => {
	const MARK = {
		lastBackupAt: 1716800000000,
		backupGenProfile: 1,
		backupGenTimeline: 3,
		backupGenCalendar: 0
	};
	const ROWS = [
		'keystore',
		'profile',
		'profile-hwm',
		'timeline-state-hwm',
		'calendar-sync-hwm',
		'skillbridge-finder-hwm'
	];

	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	async function putSidecar(
		store: 'timeline-state-hwm' | 'calendar-sync-hwm' | 'skillbridge-finder-hwm',
		generation: number,
		ts: number
	): Promise<void> {
		const ks = need(await readRow('keystore'));
		const signed = await signSidecar(
			store,
			{ generation, keystoreGeneration: 0, epoch: 0, ts },
			ks.hmacKeyRef as CryptoKey
		);
		await putRow(store, { id: 0, ...signed });
	}

	it('a fresh bootstrap reads all generations 0 and no mark', async () => {
		const hwm = need(await readRow('profile-hwm'));
		const state = await readDeviceState(db);
		expect(state.gens).toEqual({ profile: 0, timeline: 0, calendar: 0, finder: 0 });
		// Bootstrap signs the profile mark; the other sidecars do not exist yet, so they have no time.
		expect(state.ts).toEqual({
			profile: (hwm.payload as ProfileHwmPayload).ts,
			timeline: null,
			calendar: null,
			finder: null
		});
		expect(state.mark).toBeNull();
		expect(state.lastSeenAt).toBeNull();
	});

	it('reads the generations and times the four sidecars carry', async () => {
		await createProfileStore(db).save({ eaos: bytes('2027-04-15') });
		await putSidecar('timeline-state-hwm', 5, 111);
		await putSidecar('calendar-sync-hwm', 2, 222);
		await putSidecar('skillbridge-finder-hwm', 4, 333);
		const state = await readDeviceState(db);
		expect(state.gens).toEqual({ profile: 1, timeline: 5, calendar: 2, finder: 4 });
		expect(state.ts.timeline).toBe(111);
		expect(state.ts.calendar).toBe(222);
		expect(state.ts.finder).toBe(333);
	});

	// The profile mark and the saved record each carry a time; lastSeenAt is the record's, so give the mark another.
	it("copies lastSeenAt from the saved record, not from the profile mark's time", async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: bytes('2027-04-15') });
		const saved = need(store._getStateForTest()).lastSeenAt;
		const ks = need(await readRow('keystore'));
		const MARK_TS = 42;
		expect(saved).not.toBe(MARK_TS);
		const resigned = await signSidecar(
			'profile-hwm',
			{ generation: 1, keystoreGeneration: 0, epoch: 0, ts: MARK_TS },
			ks.hmacKeyRef as CryptoKey
		);
		await putRow('profile-hwm', { id: 0, ...resigned });
		const state = await readDeviceState(db);
		expect(state.ts.profile).toBe(MARK_TS);
		expect(state.lastSeenAt).toBe(saved);
	});

	it('readDeviceState reads all six rows in one transaction', async () => {
		const spy = vi.spyOn(db, 'transaction');
		await readDeviceState(db);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toEqual(ROWS);
		expect(spy.mock.calls[0]?.[1]).toBe('readonly');
	});

	it('readDeviceState zeroizes the decoded profile', async () => {
		await createProfileStore(db).save({ eaos: bytes('2027-04-15'), ...MARK });
		seams.zeroized.length = 0;
		await readDeviceState(db);
		expect(seams.zeroized).toHaveLength(1);
		const decoded = need(seams.zeroized[0]);
		expect(decoded.generation).toBe(1);
		expect(decoded.lastBackupAt).toBe(MARK.lastBackupAt);
		expect(allZero(decoded.eaos as Uint8Array)).toBe(true);
	});

	// A mark made before the finder existed has the four older fields and is still a mark: the finder it matched was
	// empty then, so a missing finder generation reads as 0.
	it('readDeviceState returns a mark only when the four older fields are present, and reads a missing finder generation as 0', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: bytes('2027-04-15'), lastBackupAt: 5, backupGenProfile: 1 });
		await store.save({ backupGenTimeline: 3 });
		expect((await readDeviceState(db)).mark).toBeNull();
		await store.save({ backupGenCalendar: 0 });
		const state = await readDeviceState(db);
		expect(state.mark).toEqual({
			at: 5,
			gens: { profile: 1, timeline: 3, calendar: 0, finder: 0 }
		});
		expect(state.gens.profile).toBe(3);
	});

	it('readDeviceState reads the finder generation a mark carries', async () => {
		await createProfileStore(db).save({ eaos: bytes('2027-04-15'), ...MARK, backupGenFinder: 4 });
		expect((await readDeviceState(db)).mark).toEqual({
			at: MARK.lastBackupAt,
			gens: { profile: 1, timeline: 3, calendar: 0, finder: 4 }
		});
	});

	it('a tampered finder sidecar is DEVICE_DAMAGED', async () => {
		await putSidecar('skillbridge-finder-hwm', 2, 333);
		const row = need(await readRow('skillbridge-finder-hwm'));
		const payload = row.payload as ProfileHwmPayload;
		await putRow('skillbridge-finder-hwm', { ...row, payload: { ...payload, generation: 3 } });
		await expect(readDeviceState(db)).rejects.toThrow('E_RESTORE_DEVICE_DAMAGED');
	});

	it('a tampered timeline sidecar is DEVICE_DAMAGED', async () => {
		await putSidecar('timeline-state-hwm', 5, 111);
		const row = need(await readRow('timeline-state-hwm'));
		const payload = row.payload as ProfileHwmPayload;
		await putRow('timeline-state-hwm', { ...row, payload: { ...payload, generation: 6 } });
		await expect(readDeviceState(db)).rejects.toThrow('E_RESTORE_DEVICE_DAMAGED');
	});

	it('a tampered calendar sidecar is DEVICE_DAMAGED', async () => {
		await putSidecar('calendar-sync-hwm', 2, 222);
		const row = need(await readRow('calendar-sync-hwm'));
		const payload = row.payload as ProfileHwmPayload;
		await putRow('calendar-sync-hwm', { ...row, payload: { ...payload, generation: 3 } });
		await expect(readDeviceState(db)).rejects.toThrow('E_RESTORE_DEVICE_DAMAGED');
	});

	// Only the time is forged and the generation stays 0, so no body is read and no body is missing: the one thing
	// that can stop this read is the sidecar's own MAC.
	it('a profile mark with a forged time is DEVICE_DAMAGED', async () => {
		const hwm = need(await readRow('profile-hwm'));
		const payload = hwm.payload as ProfileHwmPayload;
		await putRow('profile-hwm', { ...hwm, payload: { ...payload, ts: payload.ts + 1 } });
		await expect(readDeviceState(db)).rejects.toThrow('E_RESTORE_DEVICE_DAMAGED');
	});

	it('a tampered keystore record is DEVICE_DAMAGED', async () => {
		const ks = need(await readRow('keystore'));
		await putRow('keystore', { ...ks, keystoreGeneration: 7 }); // not re-signed
		await expect(readDeviceState(db)).rejects.toThrow('E_RESTORE_DEVICE_DAMAGED');
	});

	it('a profile mark of 1 or more with no body row is DEVICE_DAMAGED', async () => {
		await createProfileStore(db).save({ eaos: bytes('2027-04-15') });
		await withStores(db, 'profile', 'readwrite', (tx) => {
			tx.objectStore('profile').clear();
		});
		await expect(readDeviceState(db)).rejects.toThrow('E_RESTORE_DEVICE_DAMAGED');
	});

	it('a body that no longer decrypts is DEVICE_DAMAGED', async () => {
		await createProfileStore(db).save({ eaos: bytes('2027-04-15') });
		const row = need(await readRow('profile'));
		const rec = new Uint8Array(row.rec as Uint8Array);
		rec[rec.length - 1] = (rec[rec.length - 1] ?? 0) ^ 1;
		await putRow('profile', { ...row, rec });
		await expect(readDeviceState(db)).rejects.toThrow('E_RESTORE_DEVICE_DAMAGED');
	});
});
