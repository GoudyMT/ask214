import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createByokStore } from '../ask/byok/store';
import { KDF_V1 } from '../backup/kdf-params';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { AesGcmAuthError } from '../crypto/aes-gcm';
import { decryptRecord } from '../crypto/record-crypto';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { reqToPromise, STORES, withStores, type StoreName } from '../db/schema';
import { readDeviceState } from '../profile/device-state';
import { decodeEaos, encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { createProfileStore } from '../profile/store.svelte';
import { cleanListing } from '../skillbridge-finder/fixtures/clean';
import { createFinderPackStore } from '../skillbridge-finder/state/pack-store.svelte';
import { createFinderStore } from '../skillbridge-finder/state/store.svelte';
import { KNOWN_TASK_IDS } from '../timeline/known-task-ids';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { readCounter, readTries } from './app-lock-store';
import { bootstrapLocalKeystore } from './bootstrap';
import { keyIdentity, verifyKeystore, type KeystoreRecordPin } from './record';
import type { KeystoreRow } from './read';
import { RotationStoreError, rotateToPin } from './rotate';
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

// Seams over two modules, each a passthrough until a test arms it. The paths are `$lib` aliases on purpose: with a
// relative path a mock silently never applied to the code's own import in this browser runner.
// - decodeProfile and decryptRecord (for the API key) keep every plaintext byte array they hand out, with a copy of what
//   it held, so a test can see which were wiped and that they held something to wipe.
type Held = { live: Uint8Array; copy: Uint8Array };
const seams = vi.hoisted(() => ({ capture: false, held: [] as Held[] }));

vi.mock('$lib/crypto/record-crypto', async (importOriginal) => {
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

vi.mock('$lib/profile/codec', async (importOriginal) => {
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
		await rotate(pin, {}, { afterPut: (_index, store) => void stores.push(store) });
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
		const pin = await pinFixture();

		const { session, packHadFiles } = await rotate(pin);
		setSession(session);

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
		const GENERATION = (gens: Awaited<ReturnType<typeof readEverything>>['gens']) =>
			[
				['profile', gens.profile],
				['timeline-state', gens.timeline],
				['calendar-sync', gens.calendar],
				['skillbridge-finder', gens.finder],
				['byok', 1]
			] as const;

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
		// The mark the export writes after a backup: the date and the four generations the file matched.
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
