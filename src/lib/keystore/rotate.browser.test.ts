import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createByokStore } from '../ask/byok/store';
import { KDF_V1 } from '../backup/kdf-params';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { AesGcmAuthError } from '../crypto/aes-gcm';
import { decryptRecord, encryptRecord } from '../crypto/record-crypto';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { ENCRYPTED_STORES, isEncryptedStore } from '../db/registry';
import { reqToPromise, STORES, withStores, type StoreName } from '../db/schema';
import { encodeProfile } from '../profile/codec';
import { decryptProfileRecord } from '../profile/crypto-boundary';
import { readDeviceState } from '../profile/device-state';
import { decodeEaos, encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { verifySidecar, type ProfileHwmPayload, type SignedSidecar } from '../profile/sidecars';
import { createProfileStore } from '../profile/store.svelte';
import { cleanListing } from '../skillbridge-finder/fixtures/clean';
import { createFinderPackStore } from '../skillbridge-finder/state/pack-store.svelte';
import { createFinderStore } from '../skillbridge-finder/state/store.svelte';
import { KNOWN_TASK_IDS } from '../timeline/known-task-ids';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { readCounter, readTries } from './app-lock-store';
import { bootstrapLocalKeystore } from './bootstrap';
import { keyIdentity, verifyKeystore, type KeystoreRecordPin } from './record';
import { keysForRow, type KeystoreRow } from './read';
import { removePin, RotationStoreError, rotateToPin } from './rotate';
import {
	assertSessionKeys,
	dropSession,
	getSession,
	openPinSession,
	setOnSessionMismatch,
	setSession,
	WrongPinError,
	type KeySession
} from './session';

// Seams over two modules, each a passthrough until a test arms it. The paths are `#lib` aliases on purpose: with a
// relative path a mock silently never applied to the code's own import in this browser runner.
// - decodeProfile and decryptRecord (for the API key) keep every plaintext byte array they hand out, with a copy of what
//   it held, so a test can see which were wiped and that they held something to wipe.
type Held = { live: Uint8Array; copy: Uint8Array };
const seams = vi.hoisted(() => ({ capture: false, held: [] as Held[] }));

vi.mock('#lib/crypto/record-crypto.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('../crypto/record-crypto')>();
	return {
		...real,
		decryptRecord: async (...args: Parameters<typeof real.decryptRecord>) => {
			const out = await real.decryptRecord(...args);
			if (seams.capture && args[0].storeName === 'byok') {
				seams.held.push({ live: out, copy: out.slice() });
			}
			return out;
		}
	};
});

vi.mock('#lib/profile/codec.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/codec')>();
	return {
		...real,
		decodeProfile: (bytes: Uint8Array) => {
			const out = real.decodeProfile(bytes);
			if (seams.capture) {
				for (const value of Object.values(out)) {
					if (value instanceof Uint8Array) seams.held.push({ live: value, copy: value.slice() });
				}
			}
			return out;
		}
	};
});

type Row = Record<string, unknown>;
type Pin = Awaited<ReturnType<typeof pinFixture>>;

const HMAC = { name: 'HMAC', hash: 'SHA-256', length: 256 } as const;
const API_KEY = 'sk-ant-rotation-test-0123456789';
const BACKUP_AT = Date.UTC(2026, 8, 1);
const PACK = 'skillbridge-finder-pack';
const TRIES_ROW = { id: 'tries', count: 2, waitMs: 30_000, pending: false };

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	seams.capture = false;
	seams.held.length = 0;
});

afterEach(async () => {
	dropSession();
	setOnSessionMismatch(null);
	vi.restoreAllMocks();
	await deleteTestDb(db);
});

function need<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error('test setup: value missing');
	return value;
}

const taskId = (i: number): string => need(KNOWN_TASK_IDS[i]);

const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function readRaw(store: StoreName): Promise<Row | undefined> {
	return withStores(db, store, 'readonly', (tx) =>
		reqToPromise<Row | undefined>(tx.objectStore(store).get(0))
	);
}

function putRaw(store: StoreName, value: Row): Promise<void> {
	return withStores(db, store, 'readwrite', (tx) => {
		tx.objectStore(store).put(value);
	});
}

/** Damage one byte inside a stored record, past its IV. */
async function flipRecordByte(store: StoreName): Promise<void> {
	const row = need(await readRaw(store));
	const rec = row.rec as Uint8Array;
	rec[20] = need(rec[20]) ^ 1;
	await putRaw(store, row);
}

/** A value as plain text, bytes included, so two reads can be compared. A stored key cannot be read, so it is a label. */
function plain(value: unknown): unknown {
	if (value instanceof Uint8Array) return `u8:${hex(value)}`;
	if (value instanceof ArrayBuffer) return `ab:${hex(new Uint8Array(value))}`;
	if (value instanceof CryptoKey) return 'CryptoKey';
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([key, inner]) => [key, plain(inner)])
		);
	}
	return value;
}

/** Every row of every store, as a person's device holds them right now. */
async function snapshot(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const store of STORES) {
		const rows = await withStores(db, store, 'readonly', (tx) =>
			reqToPromise<unknown[]>(tx.objectStore(store).getAll())
		);
		out[store] = plain(rows);
	}
	return out;
}

const packRows = () =>
	withStores(db, PACK, 'readonly', (tx) => reqToPromise<Row[]>(tx.objectStore(PACK).getAll()));

/** The write time in each of the four markers. */
async function markerTimes(): Promise<number[]> {
	const times: number[] = [];
	for (const store of [
		'profile-hwm',
		'timeline-state-hwm',
		'calendar-sync-hwm',
		'skillbridge-finder-hwm'
	] as const) {
		times.push((need(await readRaw(store)).payload as { ts: number }).ts);
	}
	return times;
}

/** Every transaction opened on a database from now until `stop`, as it was opened. */
function watchTransactions() {
	const original = IDBDatabase.prototype.transaction;
	const seen: { mode: IDBTransactionMode; durability: string; stores: string[] }[] = [];
	const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
		this: IDBDatabase,
		stores: string | Iterable<string>,
		mode?: IDBTransactionMode,
		options?: IDBTransactionOptions
	) {
		const tx = original.call(this, stores, mode, options);
		seen.push({ mode: tx.mode, durability: tx.durability, stores: [...tx.objectStoreNames] });
		return tx;
	});
	return { seen, stop: () => spy.mockRestore() };
}

/** The PIN step's two keys, as it makes them: non-extractable, the MAC key signing and the wrapping key wrapping. */
async function pinFixture() {
	const macKey = await crypto.subtle.generateKey(HMAC, false, ['sign', 'verify']);
	const kek = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, [
		'wrapKey',
		'unwrapKey'
	]);
	return { macKey, kek, salt: crypto.getRandomValues(new Uint8Array(16)) };
}

function rotate(
	pin: Pin,
	over: { counterBefore?: number } = {},
	deps?: Parameters<typeof rotateToPin>[2]
) {
	return readCounter(db).then((counter) =>
		rotateToPin(
			db,
			{
				macKey: pin.macKey,
				kek: pin.kek,
				salt: pin.salt,
				kdf: { ...KDF_V1 },
				counterBefore: over.counterBefore ?? counter
			},
			deps
		)
	);
}

/** The finder's downloaded files: public rows that every move of the keys empties. */
async function fillPack(): Promise<void> {
	const pack = createFinderPackStore(db);
	await pack.load();
	await pack.swap({
		index: {
			v: 1,
			pullDate: '2026-10-21',
			baseline: false,
			baselineDate: '2026-10-01',
			files: [{ name: 'pacific', count: 1, bytes: 100 }]
		},
		regions: new Map([
			[
				'pacific',
				{ v: 1, pullDate: '2026-10-21', file: 'pacific', listings: [cleanListing({ i: 1001 })] }
			]
		])
	});
}

/** A device built the way a person builds one: real stores and real saves, a record in every encrypted store. */
async function buildDevice() {
	await bootstrapLocalKeystore(db);
	const profile = createProfileStore(db);
	await profile.save({
		setupIntent: 'completed',
		eaos: encodeEaos(parseEaosAtRead('2027-04-15')),
		yearsOfService: 4
	});
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	await timeline.setStatus(taskId(0), 'done');
	await timeline.setStatus(taskId(1), 'skipped');
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	await calendar.setExclusions({ taskIds: [taskId(3)], categories: ['finance'] });
	const finder = createFinderStore(db);
	await finder.load();
	await finder.setSetup({ radius: 50 });
	await createByokStore(db).saveApiKey(API_KEY);
	await fillPack();
	await putRaw('app-lock', TRIES_ROW);
	return { profile };
}

/** What each store gives back through its own load: the same call before and after must give the same values. */
async function readEverything() {
	const profile = need(await createProfileStore(db).load());
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	const finder = createFinderStore(db);
	await finder.load();
	return {
		profile: {
			eaos: decodeEaos(need(profile.eaos)),
			yearsOfService: profile.yearsOfService,
			generation: profile.generation
		},
		timeline: timeline.state,
		calendar: { exclusions: calendar.exclusions, card: calendar.card },
		finder: { setup: finder.setup, filters: finder.filters, saved: finder.saved },
		apiKey: await createByokStore(db).readApiKey(),
		gens: (await readDeviceState(db)).gens
	};
}

/** Each encrypted record's store with the generation its marker says it was sealed at (the API key has one fixed number). */
const GENERATION = (gens: Awaited<ReturnType<typeof readEverything>>['gens']) =>
	[
		['profile', gens.profile],
		['timeline-state', gens.timeline],
		['calendar-sync', gens.calendar],
		['skillbridge-finder', gens.finder],
		['byok', 1]
	] as const;

/** The mark the export writes after a backup: the date and the four generations the file matched. */
async function markBackup(profile: Awaited<ReturnType<typeof buildDevice>>['profile']) {
	const { gens } = await readDeviceState(db);
	await profile.save({
		lastBackupAt: BACKUP_AT,
		backupGenProfile: gens.profile + 1,
		backupGenTimeline: gens.timeline,
		backupGenCalendar: gens.calendar,
		backupGenFinder: gens.finder
	});
	const marked = await readDeviceState(db);
	expect(marked.mark).toStrictEqual({ at: BACKUP_AT, gens: marked.gens });
	return marked;
}

async function expectUntouched(before: Record<string, unknown>) {
	expect(await snapshot()).toStrictEqual(before);
	const row = need(await readRaw('keystore'));
	expect(row.mode).toBe('local');
}

describe('rotateToPin', () => {
	it('a failure after any single put leaves every store byte for byte as it was', async () => {
		// A clean run on a device of its own, to count the puts and see which stores they reach.
		await buildDevice();
		const pin = await pinFixture();
		const stores: string[] = [];
		const cleared: string[] = [];
		const originalClear = IDBObjectStore.prototype.clear;
		const clearSpy = vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (
			this: IDBObjectStore
		) {
			cleared.push(this.name);
			return originalClear.call(this);
		});
		await rotate(pin, {}, { afterPut: (_index, store) => void stores.push(store) });
		clearSpy.mockRestore();
		// Every store the registry names is either put to or emptied: one added later cannot be left under a gone key.
		expect(
			new Set([...stores, ...cleared].filter((store) => isEncryptedStore(store)))
		).toStrictEqual(new Set(ENCRYPTED_STORES));
		expect([...stores].sort()).toStrictEqual([
			'app-lock',
			'byok',
			'calendar-sync',
			'calendar-sync-hwm',
			'keystore',
			'profile',
			'profile-hwm',
			'skillbridge-finder',
			'skillbridge-finder-hwm',
			'timeline-state',
			'timeline-state-hwm'
		]);
		await deleteTestDb(db);

		db = await openTestDb();
		await buildDevice();
		const before = await snapshot();
		for (let crashAfter = 0; crashAfter < stores.length; crashAfter++) {
			await expect(
				rotate(
					pin,
					{},
					{
						afterPut: (index) => {
							if (index === crashAfter) throw new Error('E_TEST_CRASH');
						}
					}
				)
			).rejects.toThrow('E_TEST_CRASH');
			await expectUntouched(before);
		}
		// The device still opens as it did: the local keys read its profile.
		expect(need(await createProfileStore(db).load()).yearsOfService).toBe(4);
	});

	it('every store opens through its own load under the new keys with the same values and generations', async () => {
		await buildDevice();
		const before = await readEverything();
		const old = need(await readRaw('keystore'));
		const writtenAt = await markerTimes();
		const pin = await pinFixture();

		const transactions = watchTransactions();
		const { session, packHadFiles } = await rotate(pin);
		transactions.stop();
		setSession(session);

		// One write transaction, durable, over everything the move changes - the counter and the pack included.
		const writes = transactions.seen.filter((tx) => tx.mode !== 'readonly');
		expect(writes).toHaveLength(1);
		expect(writes[0]?.durability).toBe('strict');
		expect(writes[0]?.stores).toEqual(
			expect.arrayContaining(['keystore', 'app-lock', 'skillbridge-finder-pack'])
		);
		// The markers say when each record was last written, which a move does not change.
		expect(await markerTimes()).toStrictEqual(writtenAt);
		expect(packHadFiles).toBe(true);
		expect(await readEverything()).toStrictEqual(before);
		const row = need(await readRaw('keystore')) as Row & KeystoreRecordPin;
		expect(row).toMatchObject({ mode: 'pin', keystoreGeneration: 1, epoch: 1, ivCounter: 0 });
		expect(hex(row.installUuid)).toBe(hex(old.installUuid as Uint8Array));
		expect(hex(row.salt)).toBe(hex(pin.salt));
		expect(row.kdf).toStrictEqual({ ...KDF_V1 });
		expect(row).not.toHaveProperty('dataKeyRef');
		expect(await packRows()).toStrictEqual([]);
		// The row opens the way an unlock opens it, and to the same identity the session holds.
		const unlocked = await openPinSession(row, pin, session.counter);
		expect(unlocked.identity).toStrictEqual(session.identity);
		expect(await verifyKeystore(row, { bootstrapMacKey: pin.macKey })).toBe(true);
	});

	it('a device already on a PIN moves from the live session onto a new PIN, and the old PIN no longer opens it', async () => {
		await buildDevice();
		const before = await readEverything();
		const first = await pinFixture();
		setSession((await rotate(first)).session);
		const relocked = vi.fn();
		setOnSessionMismatch(relocked);
		const second = await pinFixture();

		const { session, packHadFiles } = await rotate(second);
		setSession(session);

		expect(packHadFiles).toBe(false);
		expect(relocked).not.toHaveBeenCalled();
		expect(await readEverything()).toStrictEqual(before);
		const row = need(await readRaw('keystore')) as Row & KeystoreRecordPin;
		expect(row).toMatchObject({ mode: 'pin', keystoreGeneration: 2, epoch: 2 });
		await expect(openPinSession(row, first, session.counter)).rejects.toBeInstanceOf(WrongPinError);
		await expect(openPinSession(row, second, session.counter)).resolves.toMatchObject({
			identity: session.identity
		});
	});

	it('a device with no record yet and no cached files rotates and reports no files', async () => {
		await bootstrapLocalKeystore(db);
		const pin = await pinFixture();

		const { session, packHadFiles } = await rotate(pin);
		setSession(session);

		expect(packHadFiles).toBe(false);
		// The profile's marker was signed again under the new keys, or this load would refuse it.
		expect(await createProfileStore(db).load()).toBeNull();
		expect(need(await readRaw('keystore'))).toMatchObject({ mode: 'pin', keystoreGeneration: 1 });
	});

	describe('the keys from before', () => {
		it('cannot open any rotated record, with their identity or the new one', async () => {
			await buildDevice();
			const gens = (await readDeviceState(db)).gens;
			const old = need(await readRaw('keystore')) as unknown as KeystoreRow & {
				dataKeyRef: CryptoKey;
			};
			const pin = await pinFixture();
			const { session } = await rotate(pin);

			for (const [store, generation] of GENERATION(gens)) {
				const ctx = { storeName: store, recordId: 'self', schemaVersion: 1 };
				const rec = need(await readRaw(store)).rec as Uint8Array;
				await expect(
					decryptRecord(ctx, rec, keyIdentity(old), old.dataKeyRef, generation)
				).rejects.toBeInstanceOf(AesGcmAuthError);
				await expect(
					decryptRecord(ctx, rec, session.identity, old.dataKeyRef, generation)
				).rejects.toBeInstanceOf(AesGcmAuthError);
				// The same call with the new keys opens it, so the refusals above are about the keys.
				await expect(
					decryptRecord(ctx, rec, session.identity, session.dataKey, generation)
				).resolves.toBeInstanceOf(Uint8Array);
			}
		});

		it('a copy of the timeline sealed before the PIN does not open once the PIN is on', async () => {
			await buildDevice();
			const sealedBefore = need(await readRaw('timeline-state')).rec as Uint8Array;
			const pin = await pinFixture();
			const { session } = await rotate(pin);
			setSession(session);
			await putRaw('timeline-state', { id: 0, rec: sealedBefore });

			await expect(createTimelineStateStore(db).load()).rejects.toBeInstanceOf(AesGcmAuthError);
		});
	});

	describe('a store that will not verify or open stops the turn-on', () => {
		it.each([
			[
				'timeline-state',
				'a byte of its record flipped',
				async () => {
					await flipRecordByte('timeline-state');
				}
			],
			[
				'skillbridge-finder',
				'its marker signed over other numbers',
				async () => {
					const row = need(await readRaw('skillbridge-finder-hwm'));
					const payload = row.payload as { ts: number };
					await putRaw('skillbridge-finder-hwm', {
						...row,
						payload: { ...payload, ts: payload.ts + 1 }
					});
				}
			],
			[
				'byok',
				'a byte of the stored key flipped',
				async () => {
					await flipRecordByte('byok');
				}
			],
			[
				'profile',
				'its own generation differs from its marker',
				async () => {
					// Sealed under its marker's number but saying another inside: it opens, and sealed again at the number it
					// says it would never open at the marker's.
					const old = need(await readRaw('keystore')) as unknown as KeystoreRow & {
						dataKeyRef: CryptoKey;
					};
					const marker = need(await readRaw('profile-hwm')).payload as { generation: number };
					const profile = await decryptProfileRecord(
						need(await readRaw('profile')).rec as Uint8Array,
						keyIdentity(old),
						old.dataKeyRef,
						marker.generation
					);
					const rec = await encryptRecord(
						{ storeName: 'profile', recordId: 'self', schemaVersion: 1 },
						encodeProfile({ ...profile, generation: marker.generation + 6 }),
						keyIdentity(old),
						old.dataKeyRef,
						marker.generation
					);
					await putRaw('profile', { id: 0, rec });
				}
			]
		] as const)('%s: %s', async (store, _what, damage) => {
			await buildDevice();
			await damage();
			const before = await snapshot();
			const pin = await pinFixture();

			const failure = await rotate(pin).then(
				() => null,
				(e: unknown) => e
			);

			expect(failure).toBeInstanceOf(RotationStoreError);
			expect(failure).toMatchObject({ store, message: 'E_ROTATE_UNREADABLE' });
			await expectUntouched(before);
		});
	});

	it('keeps the backup mark true: the Settings backup card still reads the last backup as current', async () => {
		const { profile } = await buildDevice();
		const marked = await markBackup(profile);
		const pin = await pinFixture();

		const { session } = await rotate(pin);
		setSession(session);

		const after = await readDeviceState(db);
		expect(after.gens).toStrictEqual(marked.gens);
		expect(after.mark).toStrictEqual({ at: BACKUP_AT, gens: after.gens });
	});

	it('clears the wrong tries and changes the lock counter', async () => {
		await buildDevice();
		expect(await readTries(db)).toStrictEqual({ count: 2, waitMs: 30_000, pending: false });
		const counterBefore = await readCounter(db);
		const pin = await pinFixture();

		const { session } = await rotate(pin, { counterBefore });

		expect(await readTries(db)).toStrictEqual({ count: 0, waitMs: 0, pending: false });
		expect(
			await withStores(db, 'app-lock', 'readonly', (tx) =>
				reqToPromise(tx.objectStore('app-lock').get('tries'))
			)
		).toBeUndefined();
		const counterAfter = await readCounter(db);
		expect(counterAfter).not.toBe(counterBefore);
		expect(session.counter).toBe(counterAfter);
	});

	it('refuses, writing nothing, when the lock moved since the counter was noted', async () => {
		await buildDevice();
		const before = await snapshot();
		const pin = await pinFixture();
		const counter = await readCounter(db);

		await expect(rotate(pin, { counterBefore: counter + 3 })).rejects.toThrow('E_ROTATE_MOVED');
		await expectUntouched(before);
	});

	describe('plaintext left in memory', () => {
		async function expectWiped() {
			// The profile's date and the API key were both held as bytes, and every one of those arrays reads zero now.
			expect(seams.held.length).toBeGreaterThanOrEqual(2);
			for (const { live, copy } of seams.held) {
				expect(copy.some((byte) => byte !== 0)).toBe(true);
				expect(live.every((byte) => byte === 0)).toBe(true);
			}
		}

		it('is wiped when the turn-on completes', async () => {
			await buildDevice();
			const pin = await pinFixture();
			seams.capture = true;
			await rotate(pin);
			seams.capture = false;

			await expectWiped();
		});

		it('is wiped when the turn-on fails after everything was read', async () => {
			await buildDevice();
			const pin = await pinFixture();
			seams.capture = true;
			await expect(
				rotate(
					pin,
					{},
					{
						afterPut: () => {
							throw new Error('E_TEST_CRASH');
						}
					}
				)
			).rejects.toThrow('E_TEST_CRASH');
			seams.capture = false;

			await expectWiped();
		});
	});

	it('hands back keys that cannot be read out', async () => {
		await buildDevice();
		const pin = await pinFixture();

		const { session } = await rotate(pin);

		const held: KeySession = session;
		expect(() => assertSessionKeys(held)).not.toThrow();
		await expect(crypto.subtle.exportKey('raw', held.dataKey)).rejects.toThrow();
		await expect(crypto.subtle.exportKey('raw', held.hmacKey)).rejects.toThrow();
		// It does not set the session: that is the caller's.
		expect(getSession()).toBeNull();
	});
});

/** A device already on a PIN, this tab holding the session, with files in the pack again and wrong tries on record. */
async function pinDevice(opts: { markBackup?: boolean } = {}) {
	const { profile } = await buildDevice();
	const marked = opts.markBackup ? await markBackup(profile) : null;
	const first = await pinFixture();
	const { session } = await rotate(first);
	setSession(session);
	await fillPack();
	await putRaw('app-lock', TRIES_ROW);
	return { first, session, marked };
}

describe('rotateToPin, as a PIN change', () => {
	const PUTS = [
		'app-lock',
		'byok',
		'calendar-sync',
		'calendar-sync-hwm',
		'keystore',
		'profile',
		'profile-hwm',
		'skillbridge-finder',
		'skillbridge-finder-hwm',
		'timeline-state',
		'timeline-state-hwm'
	];

	// The cases below are one per put, so a put added to the move must add a case: this count fails first.
	it('makes one step for the counter, then one for each row it writes', async () => {
		await pinDevice();
		const steps: string[] = [];

		await rotate(await pinFixture(), {}, { afterPut: (_index, store) => void steps.push(store) });

		expect(steps[0]).toBe('app-lock');
		expect([...steps].sort()).toStrictEqual(PUTS);
	});

	it.each(PUTS.map((_, put) => put))(
		'a failure after put %i leaves every store byte for byte as it was, and the old PIN still opens the row',
		async (crashAfter) => {
			const { first, session } = await pinDevice();
			const before = await snapshot();
			const second = await pinFixture();

			await expect(
				rotate(
					second,
					{},
					{
						afterPut: (index) => {
							if (index === crashAfter) throw new Error('E_TEST_CRASH');
						}
					}
				)
			).rejects.toThrow('E_TEST_CRASH');

			expect(await snapshot()).toStrictEqual(before);
			const row = need(await readRaw('keystore')) as Row & KeystoreRecordPin;
			expect(row.mode).toBe('pin');
			await expect(openPinSession(row, first, session.counter)).resolves.toMatchObject({
				identity: session.identity
			});
			// The tab's own session is still the one that reads: the failed change took nothing from it.
			expect(getSession()).toBe(session);
			expect(need(await createProfileStore(db).load()).yearsOfService).toBe(4);
		}
	);

	it('moves every store onto the new PIN one generation and epoch up, with a new salt, and the old PIN no longer opens it', async () => {
		const { first, marked } = await pinDevice({ markBackup: true });
		const before = await readEverything();
		const old = need(await readRaw('keystore')) as Row & KeystoreRecordPin;
		const second = await pinFixture();

		const { session, packHadFiles } = await rotate(second);
		setSession(session);

		expect(packHadFiles).toBe(true);
		expect(await packRows()).toStrictEqual([]);
		expect(await readEverything()).toStrictEqual(before);
		const row = need(await readRaw('keystore')) as Row & KeystoreRecordPin;
		expect(row).toMatchObject({
			mode: 'pin',
			keystoreGeneration: old.keystoreGeneration + 1,
			epoch: old.epoch + 1
		});
		expect(hex(row.salt)).toBe(hex(second.salt));
		expect(hex(row.salt)).not.toBe(hex(old.salt));
		await expect(openPinSession(row, first, session.counter)).rejects.toBeInstanceOf(WrongPinError);
		// The backup card still reads the last backup as current.
		const after = await readDeviceState(db);
		expect(after.gens).toStrictEqual(need(marked).gens);
		expect(after.mark).toStrictEqual({ at: BACKUP_AT, gens: after.gens });
	});
});

/** A session over fresh keys that names `identity`: the shape the remove takes, for a case that must be refused. */
async function sessionNaming(identity: KeySession['identity']): Promise<KeySession> {
	const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
		'encrypt',
		'decrypt'
	]);
	const hmacKey = await crypto.subtle.generateKey(HMAC, false, ['sign', 'verify']);
	return { dataKey, hmacKey, bootstrapMacKey: hmacKey, identity, counter: 0 };
}

function remove(
	session: KeySession,
	over: { counterBefore?: number } = {},
	deps?: Parameters<typeof removePin>[2]
) {
	return readCounter(db).then((counter) =>
		removePin(db, { session, counterBefore: over.counterBefore ?? counter }, deps)
	);
}

/** One more save in every encrypted store while the PIN is on, so each holds a record written under the session. */
async function writeUnderSession(): Promise<void> {
	const profile = createProfileStore(db);
	await profile.load();
	await profile.save({ yearsOfService: 6 });
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	await timeline.setStatus(taskId(2), 'done');
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	await calendar.setExclusions({ taskIds: [taskId(4)], categories: [] });
	const finder = createFinderStore(db);
	await finder.load();
	await finder.setSetup({ radius: 100 });
	await createByokStore(db).saveApiKey(`${API_KEY}-2`);
}

describe('removePin', () => {
	it.each([
		[0, 'the counter'],
		[1, 'the key row'],
		[2, 'the cleared tries']
	])(
		'a failure after step %i (%s) leaves the PIN row, the counter and the tries as they were',
		async (crashAfter) => {
			const { session } = await pinDevice();
			const before = await snapshot();

			await expect(
				remove(
					session,
					{},
					{
						afterPut: (index) => {
							if (index === crashAfter) throw new Error('E_TEST_CRASH');
						}
					}
				)
			).rejects.toThrow('E_TEST_CRASH');

			expect(await snapshot()).toStrictEqual(before);
			expect(need(await readRaw('keystore')).mode).toBe('pin');
			// The tab still holds its keys: a remove that did not happen takes nothing from it.
			expect(getSession()).toBe(session);
		}
	);

	it.each(['profile', 'timeline-state', 'calendar-sync', 'skillbridge-finder', 'byok'] as const)(
		'%s: the record written under the PIN keeps its bytes and its marker, and opens on the local row',
		async (store) => {
			const { session } = await pinDevice();
			await writeUnderSession();
			const gens = (await readDeviceState(db)).gens;
			const generation = need(GENERATION(gens).find(([name]) => name === store))[1];
			const sealed = hex(need(await readRaw(store)).rec as Uint8Array);
			// The API key has no marker.
			const markStore = store === 'byok' ? null : (`${store}-hwm` as const);
			const marker = markStore === null ? undefined : await readRaw(markStore);

			await remove(session);

			const local = need(await readRaw('keystore')) as unknown as KeystoreRow;
			// The local row's own keys, not the session's: the session is gone.
			expect(local.mode).toBe('local');
			expect(getSession()).toBeNull();
			const keys = keysForRow(local);
			const rec = need(await readRaw(store)).rec as Uint8Array;
			expect(hex(rec)).toBe(sealed);
			await expect(
				decryptRecord(
					{ storeName: store, recordId: 'self', schemaVersion: 1 },
					rec,
					keyIdentity(local),
					keys.dataKey,
					generation
				)
			).resolves.toBeInstanceOf(Uint8Array);
			if (markStore !== null && marker) {
				expect(plain(await readRaw(markStore))).toStrictEqual(plain(marker));
				const { payload, mac } = marker as unknown as SignedSidecar<ProfileHwmPayload>;
				await expect(
					verifySidecar(markStore, { v: 1, payload, mac }, keys.hmacKey)
				).resolves.toMatchObject({ generation });
			}
		}
	);

	it('writes a local row on the same keys in one durable transaction, and forgets the session and the tries', async () => {
		const { session } = await pinDevice();
		await writeUnderSession();
		const before = await readEverything();
		const old = need(await readRaw('keystore')) as Row & KeystoreRecordPin;
		const counterBefore = await readCounter(db);
		const steps: string[] = [];

		const transactions = watchTransactions();
		await remove(session, {}, { afterPut: (_index, store) => void steps.push(store) });
		transactions.stop();

		const writes = transactions.seen.filter((tx) => tx.mode !== 'readonly');
		expect(writes).toHaveLength(1);
		expect(writes[0]?.durability).toBe('strict');
		expect(steps).toStrictEqual(['app-lock', 'keystore', 'app-lock']);
		const row = need(await readRaw('keystore')) as unknown as KeystoreRow;
		expect(row).toMatchObject({
			mode: 'local',
			v: 1,
			keystoreGeneration: old.keystoreGeneration,
			epoch: old.epoch,
			ivCounter: old.ivCounter
		});
		expect(hex(row.installUuid)).toBe(hex(old.installUuid));
		for (const absent of ['kdf', 'salt', 'bag']) expect(row).not.toHaveProperty(absent);
		if (row.mode !== 'local') throw new Error('test setup: the row is not local');
		expect(row.dataKeyRef.extractable).toBe(false);
		expect(row.hmacKeyRef.extractable).toBe(false);
		expect(getSession()).toBeNull();
		expect(await verifyKeystore(row, keysForRow(row))).toBe(true);
		// Every store reads through its own load with no session, to the values it held under the PIN.
		expect(await readEverything()).toStrictEqual(before);
		expect(await readTries(db)).toStrictEqual({ count: 0, waitMs: 0, pending: false });
		expect(await readCounter(db)).toBe(counterBefore + 1);
	});

	describe('refuses, writing nothing', () => {
		it('when the lock moved since the counter was noted', async () => {
			const { session } = await pinDevice();
			const before = await snapshot();

			await expect(remove(session, { counterBefore: (await readCounter(db)) + 3 })).rejects.toThrow(
				'E_ROTATE_MOVED'
			);

			expect(await snapshot()).toStrictEqual(before);
			expect(getSession()).toBe(session);
		});

		it.each([
			[
				'another generation',
				(id: KeySession['identity']) => ({ ...id, keystoreGeneration: id.keystoreGeneration + 1 })
			],
			[
				'another install',
				(id: KeySession['identity']) => ({ ...id, installUuid: new Uint8Array(16).fill(1) })
			]
		])('when the session is from %s than the row', async (_name, other) => {
			const { session } = await pinDevice();
			const before = await snapshot();

			await expect(remove(await sessionNaming(other(session.identity)))).rejects.toThrow(
				'E_ROTATE_MOVED'
			);

			expect(await snapshot()).toStrictEqual(before);
		});

		it('when the row is not a PIN row', async () => {
			await buildDevice();
			const before = await snapshot();
			const identity = keyIdentity(need(await readRaw('keystore')) as unknown as KeystoreRow);

			await expect(remove(await sessionNaming(identity))).rejects.toThrow('E_ROTATE_MOVED');

			expect(await snapshot()).toStrictEqual(before);
		});
	});
});
