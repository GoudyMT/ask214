import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import {
	createProfileStore,
	KeystoreNotInitializedError,
	KeystoreHmacMismatchError,
	OccConflictError
} from './store.svelte';
import { withStores, reqToPromise } from '../db/schema';
import { encryptProfileRecord } from './crypto-boundary';
import { signSidecar, SidecarTamperError, type ProfileHwmPayload } from './sidecars';
import { registerSecureInput } from './lifecycle';
import { IV_HARD_STOP, IvCounterExhaustedError } from '../keystore/iv-counter';
import type { ProfileV1 } from './types';

type Store = 'keystore' | 'profile-hwm' | 'profile';
type Row = Record<string, unknown>;

// Seams over three modules, each a passthrough until a test arms it:
// - cloneField records every byte array the save stages, so a test can look at the copies the store
//   made and the caller never sees;
// - decryptProfileRecord counts decrypts, so a refresh that must not read can be shown not to;
// - computeRecordHmac can be made to throw, which reaches the step right after the staged copies exist.
const seams = vi.hoisted(() => ({
	cloned: [] as Uint8Array[],
	decrypts: 0,
	failHmac: false
}));

// The paths are `$lib` aliases on purpose: with a relative path the mock silently never applied to the
// store's own import in this browser runner.
vi.mock('$lib/profile/lifecycle', async (importOriginal) => {
	const real = await importOriginal<typeof import('./lifecycle')>();
	return {
		...real,
		cloneField: (v: unknown): unknown => {
			const out = real.cloneField(v);
			if (out instanceof Uint8Array) seams.cloned.push(out);
			else if (Array.isArray(out)) {
				for (const item of out) if (item instanceof Uint8Array) seams.cloned.push(item);
			}
			return out;
		}
	};
});

vi.mock('$lib/profile/crypto-boundary', async (importOriginal) => {
	const real = await importOriginal<typeof import('./crypto-boundary')>();
	return {
		...real,
		decryptProfileRecord: (...args: Parameters<typeof real.decryptProfileRecord>) => {
			seams.decrypts++;
			return real.decryptProfileRecord(...args);
		}
	};
});

vi.mock('$lib/keystore/record', async (importOriginal) => {
	const real = await importOriginal<typeof import('../keystore/record')>();
	return {
		...real,
		computeRecordHmac: (...args: Parameters<typeof real.computeRecordHmac>) => {
			if (seams.failHmac) throw new Error('E_TEST_HMAC');
			return real.computeRecordHmac(...args);
		}
	};
});

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	seams.cloned.length = 0;
	seams.decrypts = 0;
	seams.failHmac = false;
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

describe('ProfileStore.load', () => {
	it('throws KeystoreNotInitialized when no keystore record exists', async () => {
		const store = createProfileStore(db);
		await expect(store.load()).rejects.toThrow(KeystoreNotInitializedError);
	});

	it('returns null on a freshly-bootstrapped DB (HWM generation 0, no body)', async () => {
		await bootstrapLocalKeystore(db);
		const store = createProfileStore(db);
		expect(await store.load()).toBeNull();
	});

	it('throws KeystoreHmacMismatch when a covered keystore field is tampered', async () => {
		await bootstrapLocalKeystore(db);
		const ks = await readRow('keystore');
		if (!ks) throw new Error('test setup: keystore missing');
		await putRow('keystore', { ...ks, keystoreGeneration: 7 }); // not re-signed
		const store = createProfileStore(db);
		await expect(store.load()).rejects.toThrow(KeystoreHmacMismatchError);
	});

	it('throws SidecarTamperError when the HWM payload is tampered', async () => {
		await bootstrapLocalKeystore(db);
		const hwm = await readRow('profile-hwm');
		if (!hwm) throw new Error('test setup: HWM missing');
		const payload = hwm.payload as ProfileHwmPayload;
		await putRow('profile-hwm', { ...hwm, payload: { ...payload, generation: 999 } });
		const store = createProfileStore(db);
		await expect(store.load()).rejects.toThrow(SidecarTamperError);
	});

	it('reads, verifies, and decrypts a staged profile body', async () => {
		const { record } = await bootstrapLocalKeystore(db);
		const profile: ProfileV1 = {
			schemaVersion: 1,
			generation: 1,
			lastSeenAt: 1716700000000,
			setupIntent: 'completed',
			setupIntentChangedAt: 1716700000000,
			eaos: new TextEncoder().encode('2027-04-15')
		};
		const blob = await encryptProfileRecord(profile, record);
		const hwmPayload: ProfileHwmPayload = {
			generation: 1,
			keystoreGeneration: 0,
			epoch: 0,
			ts: 1716700000000
		};
		const hwm1 = await signSidecar('profile-hwm', hwmPayload, record.hmacKeyRef);
		await withStores(db, ['profile', 'profile-hwm'], 'readwrite', (tx) => {
			tx.objectStore('profile').put({ id: 0, rec: blob });
			tx.objectStore('profile-hwm').put({ id: 0, ...hwm1 });
		});

		const store = createProfileStore(db);
		const loaded = await store.load();
		expect(loaded).not.toBeNull();
		if (loaded?.eaos) expect(new TextDecoder().decode(loaded.eaos)).toBe('2027-04-15');
		expect(store._getStateForTest()).not.toBeNull();
	});
});

describe('ProfileStore.save', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('persists the body and bumps generation to 1', async () => {
		const store = createProfileStore(db);
		const r = await store.save({
			eaos: new TextEncoder().encode('2027-04-15'),
			setupIntent: 'completed'
		});
		expect(r.generation).toBe(1);
		const body = await readRow('profile');
		expect(body).toBeDefined();
		const hwm = await readRow('profile-hwm');
		expect(hwm).toBeDefined();
		expect((hwm?.payload as ProfileHwmPayload).generation).toBe(1);
	});

	it('roundtrips through save + load', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		const loaded = await store.load();
		expect(loaded).not.toBeNull();
		if (loaded?.eaos) expect(new TextDecoder().decode(loaded.eaos)).toBe('2027-04-15');
	});

	it('bumps the keystore ivCounter', async () => {
		const before = await readRow('keystore');
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		const after = await readRow('keystore');
		expect(after?.ivCounter as number).toBeGreaterThan(before?.ivCounter as number);
	});

	it('invokes onBroadcast with profile-updated after the lock releases', async () => {
		const events: string[] = [];
		const store = createProfileStore(db, { onBroadcast: (e) => events.push(e.type) });
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		expect(events).toEqual(['profile-updated']);
	});

	it('commits the rune inside the lock (state observable post-save)', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		const state = store._getStateForTest();
		expect(state).not.toBeNull();
		if (state) expect(state.generation).toBe(1);
	});

	it('refuses a save from a stale instance instead of clobbering (auto-OCC / H1)', async () => {
		const storeA = createProfileStore(db);
		await storeA.save({ eaos: new TextEncoder().encode('2027-01-01') }); // -> gen 1
		// storeB never loaded, so its _profile is null (simulates a 2nd tab / post-relock).
		const storeB = createProfileStore(db);
		await expect(storeB.save({ setupIntent: 'completed' })).rejects.toThrow(OccConflictError);
		// storeA's data must survive - no silent clobber.
		const loaded = await storeA.load();
		expect(loaded).not.toBeNull();
		if (loaded?.eaos) expect(new TextDecoder().decode(loaded.eaos)).toBe('2027-01-01');
	});

	it('resolves concurrent first-runs: exactly one succeeds', async () => {
		const storeA = createProfileStore(db);
		const storeB = createProfileStore(db);
		const results = await Promise.allSettled([
			storeA.save({ eaos: new TextEncoder().encode('2027-01-01') }),
			storeB.save({ eaos: new TextEncoder().encode('2027-02-02') })
		]);
		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		const r0 = rejected[0];
		if (r0 && r0.status === 'rejected') expect(r0.reason).toBeInstanceOf(OccConflictError);
	});

	it('seeds lastSeenAt to ~now on first save (not clamped) and keeps it monotonic', async () => {
		const store = createProfileStore(db);
		const before = Date.now();
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		const ls1 = store._getStateForTest()?.lastSeenAt ?? 0;
		expect(ls1).toBeGreaterThanOrEqual(before);
		await store.save({ setupIntent: 'completed' });
		const ls2 = store._getStateForTest()?.lastSeenAt ?? 0;
		expect(ls2).toBeGreaterThanOrEqual(ls1);
	});
});

describe('ProfileStore.persona', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('derives persona from the current profile state', async () => {
		const store = createProfileStore(db);
		expect(store.persona.completeness).toBe('none');
		await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		expect(store.persona.completeness).toBe('eaos-only');
	});
});

describe('ProfileStore.relockSync', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('drops profile state and emits relocked synchronously', async () => {
		const events: string[] = [];
		const store = createProfileStore(db, { onBroadcast: (e) => events.push(e.type) });
		await store.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
		expect(store._getStateForTest()).not.toBeNull();

		const r = store.relockSync('user');
		expect(r).toBeUndefined(); // synchronous void return
		expect(store._getStateForTest()).toBeNull();
		expect(events).toContain('relocked');
	});

	it('zeroizes the in-memory profile bytes before dropping the reference', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		const eaosRef = store._getStateForTest()?.eaos ?? null;
		expect(eaosRef).not.toBeNull();
		store.relockSync('user');
		if (eaosRef) expect(eaosRef.every((b) => b === 0)).toBe(true);
	});

	// Every save stages a deep copy and swaps it in, so the record it replaces holds the same
	// plaintext in different bytes. Dropping it hands the collector a profile the user has already
	// moved on from - the same leak a relock exists to prevent, just on the happy path.
	it('zeroizes the record a save supersedes, rather than dropping it to the collector', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		const superseded = store._getStateForTest()?.eaos ?? null;
		expect(superseded).not.toBeNull();

		await store.save({ eaos: new TextEncoder().encode('2028-08-20') });

		if (superseded) expect(superseded.every((b) => b === 0)).toBe(true);
		// The live record is untouched - only the one being replaced is wiped.
		expect(new TextDecoder().decode(store._getStateForTest()?.eaos ?? undefined)).toBe(
			'2028-08-20'
		);
	});

	// The relocked signal is how one tab tells the others the USER locked. Page hygiene is not that:
	// this page is going away, the others are not. Telling them turns "you switched tabs" into "every
	// other tab is now locked", and since a peer relock is not restorable they stay that way.
	it('page hygiene does not tell other tabs to lock - only this page is going away', async () => {
		const events: string[] = [];
		const store = createProfileStore(db, { onBroadcast: (e) => events.push(e.type) });
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });

		store.relockSync('hygiene');

		expect(store._getStateForTest()).toBeNull();
		expect(events).not.toContain('relocked');
	});

	// A save puts the profile back in memory just as surely as a load does. If it does not say so,
	// the store sits holding plaintext while refusing every automatic re-read - so a peer's change
	// never lands in a tab that is plainly open.
	it('saving after a relock leaves the store re-readable, because the plaintext is back', async () => {
		const store = createProfileStore(db);
		store.relockSync('user');
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });

		expect(store._getStateForTest()).not.toBeNull();
		await expect(store.refresh()).resolves.not.toBeNull();
	});
});

describe('ProfileStore.lock + deferred relock', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('lock() drops state and emits relocked when no save is in flight', async () => {
		const events: string[] = [];
		const store = createProfileStore(db, { onBroadcast: (e) => events.push(e.type) });
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		await store.lock('user');
		expect(store._getStateForTest()).toBeNull();
		expect(events).toContain('relocked');
	});

	it('defers a relock requested mid-save until the save commits, then relocks', async () => {
		const events: string[] = [];
		const store = createProfileStore(db, { onBroadcast: (e) => events.push(e.type) });
		const savePromise = store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		const lockPromise = store.lock('user'); // requested while the save is still in flight
		await Promise.all([savePromise, lockPromise]);

		// the save committed (gen 1 persisted) BEFORE the deferred relock ran
		const hwm = await readRow('profile-hwm');
		expect((hwm?.payload as ProfileHwmPayload).generation).toBe(1);
		// the relock then dropped in-memory state
		expect(store._getStateForTest()).toBeNull();
		// order: data saved + announced, THEN relocked
		expect(events).toEqual(['profile-updated', 'relocked']);
	});
});

describe('ProfileStore.clockBackward', () => {
	async function stageFutureProfile(future: number): Promise<void> {
		const { record } = await bootstrapLocalKeystore(db);
		const profile: ProfileV1 = {
			schemaVersion: 1,
			generation: 1,
			lastSeenAt: future,
			setupIntent: 'completed',
			setupIntentChangedAt: future,
			eaos: null
		};
		const blob = await encryptProfileRecord(profile, record);
		const hwm = await signSidecar(
			'profile-hwm',
			{ generation: 1, keystoreGeneration: 0, epoch: 0, ts: future },
			record.hmacKeyRef
		);
		await withStores(db, ['profile', 'profile-hwm'], 'readwrite', (tx) => {
			tx.objectStore('profile').put({ id: 0, rec: blob });
			tx.objectStore('profile-hwm').put({ id: 0, ...hwm });
		});
	}

	it('is true when the stored lastSeenAt is in the future (clock moved backward)', async () => {
		await stageFutureProfile(Date.now() + 48 * 3600 * 1000); // 2 days ahead -> past the 24h grace
		const store = createProfileStore(db);
		await store.load();
		expect(store.clockBackward).toBe(true);
	});

	it('is false for a recent lastSeenAt', async () => {
		await bootstrapLocalKeystore(db);
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		expect(store.clockBackward).toBe(false);
	});

	it('clearClockBackward resets lastSeenAt to now, durably clearing the warning', async () => {
		await stageFutureProfile(Date.now() + 48 * 3600 * 1000);
		const store = createProfileStore(db);
		await store.load();
		expect(store.clockBackward).toBe(true);

		await store.clearClockBackward();
		expect(store.clockBackward).toBe(false);

		// durable: a fresh store reloading sees the lowered mark, no warning
		const store2 = createProfileStore(db);
		await store2.load();
		expect(store2.clockBackward).toBe(false);
	});

	it('restores the in-memory lastSeenAt if the clear save fails (OCC), staying backward', async () => {
		await stageFutureProfile(Date.now() + 48 * 3600 * 1000);
		const store = createProfileStore(db);
		await store.load();
		expect(store.clockBackward).toBe(true);
		const before = store._getStateForTest()?.lastSeenAt;

		// Another instance advances the generation so our clear's save() loses the OCC race.
		const other = createProfileStore(db);
		await other.load();
		await other.save({ setupIntent: 'completed' });

		await expect(store.clearClockBackward()).rejects.toThrow(OccConflictError);
		// The lowered mark must be rolled back (not left violating monotonicity in memory).
		expect(store._getStateForTest()?.lastSeenAt).toBe(before);
		expect(store.clockBackward).toBe(true);
	});
});

describe('ProfileStore relock-vs-save race', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	// The first-run branch of load() - keystore present, no profile written yet - resets the store to
	// open like any other successful read. But on a first-run tab that is the one branch a relock is
	// most likely to race: there is no profile to show, so nothing looks wrong, and the tab is left
	// willing to decrypt whatever a peer writes next.
	it('a relock during a first-run load is not undone by the empty-profile branch', async () => {
		const peer = createProfileStore(db);
		const tab = createProfileStore(db);

		const inflight = tab.load();
		tab.relockSync('user');
		await inflight;

		// The peer finishes setup. Our tab relocked, so it must not decrypt what the peer wrote.
		await peer.save({ eaos: new TextEncoder().encode('2027-04-15') });
		await tab.refresh();

		expect(tab._getStateForTest()).toBeNull();
	});

	it('a sync relock during an in-flight save does NOT re-populate _profile (PII residency)', async () => {
		const store = createProfileStore(db);
		// Start a save, then synchronously relock while it is mid-flight (simulates a
		// pagehide/freeze handler firing during the save's await).
		const p = store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		store.relockSync('hygiene');
		await p;
		// Memory must stay relocked - the resuming save must not re-populate decrypted PII.
		expect(store._getStateForTest()).toBeNull();
		// But the write persisted durably (the user's edit is not lost).
		const store2 = createProfileStore(db);
		const loaded = await store2.load();
		expect(loaded).not.toBeNull();
		if (loaded?.eaos) expect(new TextDecoder().decode(loaded.eaos)).toBe('2027-04-15');
	});

	it('a normal save (no relock) still commits _profile', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		expect(store._getStateForTest()).not.toBeNull();
	});

	it('decouples the staged record from _profile so a mid-save relock cannot corrupt carried fields', async () => {
		const store = createProfileStore(db);
		// gen1 carries eaos + rank.
		await store.save({
			eaos: new TextEncoder().encode('2027-04-15'),
			rank: new TextEncoder().encode('E5')
		});
		const oldRank = store._getStateForTest()?.rank ?? null;
		expect(oldRank).not.toBeNull();

		// A second save carries `rank` over (not in the patch).
		await store.save({ eaos: new TextEncoder().encode('2028-01-01') });
		const newRank = store._getStateForTest()?.rank ?? null;
		expect(newRank).not.toBeNull();

		// The carried field must be a FRESH copy, not shared with the prior profile - so a
		// concurrent relock zeroizing the prior _profile's arrays in place (simulated here by
		// fill(0)) cannot reach into the staged record that gets encrypted.
		expect(newRank).not.toBe(oldRank);
		if (oldRank) oldRank.fill(0);
		if (newRank) expect(new TextDecoder().decode(newRank)).toBe('E5');
	});
});

describe('ProfileStore.locked', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('is false on a freshly-bootstrapped DB (never set up, not locked)', async () => {
		const store = createProfileStore(db);
		await store.load(); // generation 0 -> null
		expect(store.locked).toBe(false);
	});

	it('is false while a profile is loaded in memory', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		expect(store.locked).toBe(false);
	});

	it('is true after relock when a profile exists in storage', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		store.relockSync('user');
		expect(store.locked).toBe(true);
	});

	it('is false again after unlock (reload)', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });
		store.relockSync('user');
		expect(store.locked).toBe(true);
		await store.load();
		expect(store.locked).toBe(false);
	});
});

describe('ProfileStore.wipe', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('clears all encrypted stores and resets in-memory state', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });

		await store.wipe();

		expect(await readRow('keystore')).toBeUndefined();
		expect(await readRow('profile')).toBeUndefined();
		expect(await readRow('profile-hwm')).toBeUndefined();
		expect(store._getStateForTest()).toBeNull();
		expect(store.locked).toBe(false);
		expect(store.persona.completeness).toBe('none');
	});

	it('leaves the DB in a first-run state (a subsequent load throws KeystoreNotInitialized)', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: new TextEncoder().encode('2027-04-15') });

		await store.wipe();

		await expect(store.load()).rejects.toThrow(KeystoreNotInitializedError);
	});
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | null | undefined): string => new TextDecoder().decode(b ?? undefined);
const allZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

function need<T>(v: T | null | undefined): T {
	if (v === null || v === undefined) throw new Error('test setup: missing value');
	return v;
}

// Wraps a database so a test can make every read-write transaction fail, which is the failure that
// lands after the staged record has been encrypted and signed.
function failableWrites(real: IDBDatabase, flag: { on: boolean }): IDBDatabase {
	return new Proxy(real, {
		get(target, prop) {
			if (prop === 'transaction') {
				return (stores: string | string[], mode?: IDBTransactionMode) => {
					if (flag.on && mode === 'readwrite') throw new Error('E_TEST_WRITE');
					return target.transaction(stores, mode);
				};
			}
			const value: unknown = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

describe('ProfileStore.load memory hygiene', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	// The record a load replaces holds the profile the heap was already holding; dropping it to the
	// collector leaves that plaintext in memory until some later GC, exactly what a relock exists to stop.
	it('zeroizes the record a load replaces', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: bytes('2027-04-15'), rank: bytes('E5') });
		const old = need(store._getStateForTest());
		const oldEaos = need(old.eaos);
		const oldRank = need(old.rank);
		expect(oldEaos.some((b) => b !== 0)).toBe(true);

		await store.load();

		expect(allZero(oldEaos)).toBe(true);
		expect(allZero(oldRank)).toBe(true);
		// The replacement is a fresh decrypt, untouched.
		expect(text(store._getStateForTest()?.eaos)).toBe('2027-04-15');
	});

	it('zeroizes the record a first-run load replaces with nothing', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: bytes('2027-04-15') });
		const oldEaos = need(need(store._getStateForTest()).eaos);
		const ks = need(await readRow('keystore'));
		const zeroHwm = await signSidecar(
			'profile-hwm',
			{ generation: 0, keystoreGeneration: 0, epoch: 0, ts: 1 },
			ks.hmacKeyRef as CryptoKey
		);
		await putRow('profile-hwm', { id: 0, ...zeroHwm });

		await expect(store.load()).resolves.toBeNull();

		expect(store._getStateForTest()).toBeNull();
		expect(allZero(oldEaos)).toBe(true);
	});
});

describe('ProfileStore.save failure hygiene', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	// A save that throws after the copies are made leaves them unreachable but still full of the
	// profile. Everything the store staged must be wiped; nothing the caller or the live record owns may be.
	async function failedSaveLeavesNothing(
		arm: (flag: { on: boolean }) => Promise<void> | void,
		message: string
	): Promise<void> {
		const flag = { on: false };
		const store = createProfileStore(failableWrites(db, flag));
		await store.save({ eaos: bytes('2027-04-15'), rank: bytes('E5') });
		const live = need(store._getStateForTest());
		seams.cloned.length = 0;
		await arm(flag);

		const patch = bytes('2028-08-20');
		await expect(store.save({ eaos: patch })).rejects.toThrow(message);

		expect(seams.cloned.length).toBeGreaterThan(0);
		expect(seams.cloned.every(allZero)).toBe(true);
		expect(text(patch)).toBe('2028-08-20');
		expect(text(live.eaos)).toBe('2027-04-15');
		expect(text(live.rank)).toBe('E5');
	}

	it('wipes the staged copies when the iv counter is exhausted', async () => {
		await failedSaveLeavesNothing(async () => {
			const ks = need(await readRow('keystore'));
			await putRow('keystore', { ...ks, ivCounter: IV_HARD_STOP });
		}, new IvCounterExhaustedError().message);
	});

	it('wipes the staged copies when signing the keystore record throws', async () => {
		await failedSaveLeavesNothing(() => {
			seams.failHmac = true;
		}, 'E_TEST_HMAC');
	});

	it('wipes the staged copies when the write fails', async () => {
		await failedSaveLeavesNothing((flag) => {
			flag.on = true;
		}, 'E_TEST_WRITE');
	});

	// The broadcast runs after the lock releases, when the staged record IS the live profile. A wipe
	// that covered it would erase the profile the user just saved.
	it('keeps the live profile when the broadcast after a committed save throws', async () => {
		const store = createProfileStore(db, {
			onBroadcast: () => {
				throw new Error('E_TEST_BROADCAST');
			}
		});
		await expect(store.save({ eaos: bytes('2027-04-15') })).rejects.toThrow('E_TEST_BROADCAST');
		expect(text(store._getStateForTest()?.eaos)).toBe('2027-04-15');
	});
});

describe('ProfileStore.refresh while the page is hidden', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	const stubVisibility = (state: DocumentVisibilityState) =>
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);

	it('does not decrypt on a hidden re-read, and reads again once the page is visible', async () => {
		expect(document.visibilityState).toBe('visible');
		const store = createProfileStore(db);
		await store.save({ eaos: bytes('2027-04-15') });
		store.relockSync('hygiene');
		seams.decrypts = 0;

		const visibility = stubVisibility('hidden');
		await expect(store.refresh()).resolves.toBeNull();
		expect(seams.decrypts).toBe(0);
		expect(store._getStateForTest()).toBeNull();

		visibility.mockReturnValue('visible');
		await expect(store.refresh()).resolves.not.toBeNull();
		expect(seams.decrypts).toBe(1);
		expect(text(store._getStateForTest()?.eaos)).toBe('2027-04-15');
	});

	it('leaves an unlocked store on what it holds until the page is visible', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: bytes('2027-04-15') });
		const peer = createProfileStore(db);
		await peer.load();
		await peer.save({ eaos: bytes('2028-08-20') });
		seams.decrypts = 0;

		const visibility = stubVisibility('hidden');
		expect(await store.refresh()).toBe(store._getStateForTest());
		expect(seams.decrypts).toBe(0);
		expect(text(store._getStateForTest()?.eaos)).toBe('2027-04-15');

		visibility.mockReturnValue('visible');
		await store.refresh();
		expect(text(store._getStateForTest()?.eaos)).toBe('2028-08-20');
	});

	it('still refuses a locked store, hidden or not', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: bytes('2027-04-15') });
		store.relockSync('user');
		seams.decrypts = 0;

		await store.refresh();
		stubVisibility('hidden');
		await store.refresh();

		expect(seams.decrypts).toBe(0);
		expect(store._getStateForTest()).toBeNull();
	});

	// Unlock and start-up read through load(), and they must work whatever the page is doing.
	it('does not gate load, which is the user asking', async () => {
		const store = createProfileStore(db);
		await store.save({ eaos: bytes('2027-04-15') });
		store.relockSync('user');
		seams.decrypts = 0;

		stubVisibility('hidden');
		await store.load();

		expect(seams.decrypts).toBe(1);
		expect(text(store._getStateForTest()?.eaos)).toBe('2027-04-15');
	});
});

describe('ProfileStore relock DOM scrub', () => {
	beforeEach(async () => {
		await bootstrapLocalKeystore(db);
	});

	it('scrubs registered secure inputs on relock even when no profile is loaded (wizard path)', () => {
		const input = document.createElement('input');
		input.value = '2027-04-15';
		const unregister = registerSecureInput(input);
		try {
			// Never loaded -> _profile is null (first-run wizard, where a typed EAOS lives only in
			// the DOM input). A pagehide/freeze relock must still clear it.
			const store = createProfileStore(db);
			store.relockSync('hygiene');
			expect(input.value).toBe('');
		} finally {
			unregister();
		}
	});
});
