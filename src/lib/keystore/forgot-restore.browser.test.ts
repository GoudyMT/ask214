import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createByokStore } from '../ask/byok/store';
import { KDF_V1 } from '../backup/kdf-params';
import type { RestoreOptions, RestoreResult } from '../backup/restore-writer';
import { validateInner, type ValidInner } from '../backup/validate';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { RunAbortedError } from '../db/locks';
import { reqToPromise, STORES, withStores, type StoreName } from '../db/schema';
import { encodeProfile } from '../profile/codec';
import { readDeviceState } from '../profile/device-state';
import { decodeEaos, encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { verifySidecar, type ProfileHwmPayload, type SignedSidecar } from '../profile/sidecars';
import { createProfileStore } from '../profile/store.svelte';
import { CLEAN_CASES, cleanListing } from '../skillbridge-finder/fixtures/clean';
import { createFinderPackStore } from '../skillbridge-finder/state/pack-store.svelte';
import { createFinderStore } from '../skillbridge-finder/state/store.svelte';
import { KNOWN_TASK_IDS } from '../timeline/known-task-ids';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { readCounter, readTries } from './app-lock-store';
import { bootstrapLocalKeystore } from './bootstrap';
import { readLockedDevice, restoreLockedDevice } from './forgot-restore';
import { keysForRow, KeystoreNotInitializedError, readKeystoreRow, type KeystoreRow } from './read';
import { keyIdentity, verifyKeystore } from './record';
import { rotateToPin } from './rotate';
import {
	dropSession,
	getSession,
	KeystoreLockedError,
	setSession,
	type KeySession
} from './session';

// Seams over two modules, each a passthrough until a test arms it. The paths are `$lib` aliases on purpose: with a
// relative path a mock silently never applied to the writer's own import in this browser runner.
// - encodeProfile keeps every buffer it hands out while armed, so a test can see which were wiped;
// - zeroizeRecord keeps every record it wipes, so a test can look at what the writer left behind.
const seams = vi.hoisted(() => ({
	capture: false,
	encoded: [] as Uint8Array[],
	zeroized: [] as Record<string, unknown>[]
}));

vi.mock('$lib/profile/codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/codec')>();
	return {
		...real,
		encodeProfile: (...args: Parameters<typeof real.encodeProfile>) => {
			const out = real.encodeProfile(...args);
			if (seams.capture) seams.encoded.push(out);
			return out;
		}
	};
});

vi.mock('$lib/profile/lifecycle', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/lifecycle')>();
	return {
		...real,
		zeroizeRecord: (rec: Record<string, unknown>): void => {
			if (seams.capture) seams.zeroized.push(rec);
			real.zeroizeRecord(rec);
		}
	};
});

type Bag = Record<string, unknown>;
type Row = Record<string, unknown>;

const NOW = Date.now();
const DAY = 86_400_000;
// A generation no device record ever has, so a seam can tell the file's profile from the device's.
const FILE_GENERATION = 41;
const PACK = 'skillbridge-finder-pack';
const API_KEY = 'sk-ant-forgot-test-0123456789';
const TRIES_ROW = { id: 'tries', count: 2, waitMs: 30_000, pending: false };
// The steps of the transaction: one clear per store, the lock counter, then the keystore row and the four pairs.
const STEPS: StoreName[] = [
	...STORES,
	'app-lock',
	'keystore',
	'profile',
	'profile-hwm',
	'timeline-state',
	'timeline-state-hwm',
	'calendar-sync',
	'calendar-sync-hwm',
	'skillbridge-finder',
	'skillbridge-finder-hwm'
];
const DEVICE = { profile: 3, timeline: 2, calendar: 2, finder: 2 };

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	seams.capture = false;
	seams.encoded.length = 0;
	seams.zeroized.length = 0;
});

afterEach(async () => {
	dropSession();
	vi.restoreAllMocks();
	await deleteTestDb(db);
});

function need<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error('test setup: value missing');
	return value;
}

const taskId = (i: number): string => need(KNOWN_TASK_IDS[i % 8]);

const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function readRaw(store: StoreName, id: IDBValidKey = 0): Promise<Row | undefined> {
	return withStores(db, store, 'readonly', (tx) =>
		reqToPromise<Row | undefined>(tx.objectStore(store).get(id))
	);
}

function putRaw(store: StoreName, value: Row): Promise<void> {
	return withStores(db, store, 'readwrite', (tx) => {
		tx.objectStore(store).put(value);
	});
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
		out[store] = plain(
			await withStores(db, store, 'readonly', (tx) =>
				reqToPromise<unknown[]>(tx.objectStore(store).getAll())
			)
		);
	}
	return out;
}

/** The write time in each of the four plaintext markers. */
async function markerTimes(): Promise<number[]> {
	return Promise.all(
		(
			['profile-hwm', 'timeline-state-hwm', 'calendar-sync-hwm', 'skillbridge-finder-hwm'] as const
		).map(async (store) => (need(await readRaw(store)).payload as { ts: number }).ts)
	);
}

const rowsOf = (store: StoreName) =>
	withStores(db, store, 'readonly', (tx) => reqToPromise<Row[]>(tx.objectStore(store).getAll()));

/** The two keys the PIN step would derive, fixed so no Argon2id runs: non-extractable, as the real step makes them. */
async function pinKeys() {
	const macKey = await crypto.subtle.importKey(
		'raw',
		new Uint8Array(32).fill(7),
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		false,
		['sign', 'verify']
	);
	const kek = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(9), 'AES-KW', false, [
		'wrapKey',
		'unwrapKey'
	]);
	return { macKey, kek };
}

/**
 * A device a person left behind a forgotten PIN: real saves in every store (an API key and cached finder files too), the
 * wrong tries noted, and the shipped turn-on moving it all onto a PIN. Nothing is unlocked afterwards. The session the
 * turn-on made is handed back for the test that wants a tab that was open on the old row.
 */
async function buildPinDevice(): Promise<{ session: KeySession }> {
	await bootstrapLocalKeystore(db);
	const profile = createProfileStore(db);
	for (let i = 0; i < DEVICE.profile; i++) {
		await profile.save(
			i === 0
				? { setupIntent: 'completed', eaos: encodeEaos(parseEaosAtRead('2027-04-15')) }
				: { yearsOfService: i }
		);
	}
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	for (let i = 0; i < DEVICE.timeline; i++) {
		await timeline.setStatus(taskId(i), i % 2 === 0 ? 'done' : 'skipped');
	}
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	for (let i = 0; i < DEVICE.calendar; i++) {
		await calendar.setExclusions({ taskIds: [taskId(i + 3)], categories: [] });
	}
	const finder = createFinderStore(db);
	await finder.load();
	for (let i = 0; i < DEVICE.finder; i++) await finder.setSetup({ radius: i % 2 === 0 ? 50 : 25 });
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
	const keys = await pinKeys();
	const { session } = await rotateToPin(db, {
		...keys,
		salt: new Uint8Array(16).fill(3),
		kdf: { ...KDF_V1 },
		counterBefore: await readCounter(db)
	});
	return { session };
}

const FILE_TIMELINE: Bag = {
	schemaVersion: 1,
	tasks: {
		'tap-course': { status: 'snoozed', snoozeUntil: '2027-01-15', notes: 'Call the TAP office' },
		'job-search': { status: 'done' }
	}
};
const FILE_CALENDAR: Bag = {
	schemaVersion: 1,
	exclusions: { taskIds: ['will-poa'], categories: ['finance'] },
	card: { dismissedAt: NOW, dismissCount: 2 }
};
const FILE_FINDER: Bag = {
	schemaVersion: 1,
	finderSetup: { place: { kind: 'state', state: 'TX' }, radius: 100, overseas: true },
	finderFilters: { branches: ['Navy'], kinds: ['internship'] },
	finderSaved: [{ id: 1013, savedOn: '2026-10-20', facts: CLEAN_CASES.multiState }],
	finderCompare: [1013]
};

/** A backup made on another phone, run through the real validator. */
function fileInner(): ValidInner {
	const date = (iso: string) => encodeEaos(parseEaosAtRead(iso));
	const profile = JSON.parse(
		new TextDecoder().decode(
			encodeProfile({
				schemaVersion: 1,
				generation: FILE_GENERATION,
				lastSeenAt: NOW - 40 * DAY,
				setupIntent: 'completed',
				setupIntentChangedAt: NOW - 90 * DAY,
				eaos: date('2028-02-01'),
				terminalLeaveStart: date('2028-01-01')
			})
		)
	) as Bag;
	const checked = validateInner(
		JSON.parse(
			JSON.stringify({
				appVersion: __APP_VERSION__,
				backupSchema: 1,
				createdAt: NOW - 5 * DAY,
				stores: {
					profile,
					'timeline-state': FILE_TIMELINE,
					'calendar-sync': FILE_CALENDAR,
					'skillbridge-finder': FILE_FINDER
				}
			})
		) as unknown
	);
	if (!checked.ok) throw new Error('test setup: the file does not validate');
	return checked.inner;
}

type Run = {
	ctl: AbortController;
	mayCommit: ReturnType<typeof vi.fn<() => boolean>>;
	onCommitting: ReturnType<typeof vi.fn<() => void>>;
	options: RestoreOptions & { afterPut?: (index: number, store: StoreName) => void };
};

/** The session a caller supplies: a run signal and the two callbacks. */
function run(
	over: {
		mayCommit?: () => boolean;
		afterPut?: Run['options']['afterPut'];
		now?: () => number;
	} = {}
): Run {
	const ctl = new AbortController();
	const mayCommit = vi.fn(over.mayCommit ?? (() => true));
	const onCommitting = vi.fn<() => void>();
	return {
		ctl,
		mayCommit,
		onCommitting,
		options: {
			signal: ctl.signal,
			mayCommit,
			onCommitting,
			now: over.now ?? (() => Date.now()),
			...(over.afterPut && { afterPut: over.afterPut })
		}
	};
}

/** What the confirm shows: read with no key, as the flow reads it. */
const confirmNow = async () => {
	const { gens, installUuid } = await readLockedDevice(db);
	return { gens, installUuid };
};

function expectSucceeded(result: RestoreResult) {
	expect(result).toMatchObject({ ok: true });
	if (!result.ok) throw new Error('E_TEST_RESTORE_FAILED');
	return result.gens;
}

describe('readLockedDevice', () => {
	it('reads the install and the generations from the plaintext markers, with no key', async () => {
		await buildPinDevice();

		const device = await readLockedDevice(db);

		expect(device.gens).toStrictEqual(DEVICE);
		const row = need(await readRaw('keystore'));
		expect(hex(device.installUuid)).toBe(hex(row.installUuid as Uint8Array));
		expect(device.lastTs).toBe(Math.max(...(await markerTimes())));
	});

	it('refuses a device that is not behind a PIN, so the flow reads it as a device that changed', async () => {
		await bootstrapLocalKeystore(db);

		await expect(readLockedDevice(db)).rejects.toBeInstanceOf(KeystoreNotInitializedError);
	});
});

describe('restoreLockedDevice', () => {
	it('walks the steps in order: every store emptied, the counter, the keystore row, then the four pairs', async () => {
		await buildPinDevice();
		const seen: string[] = [];

		const result = await restoreLockedDevice(
			db,
			fileInner(),
			await confirmNow(),
			run({ afterPut: (_index, store) => void seen.push(store) }).options
		);

		expectSucceeded(result);
		expect(seen).toStrictEqual(STEPS);
	});

	it.each(STEPS.map((store, k) => [k, store] as const))(
		'a failure after step %i (%s) leaves every store byte for byte as it was',
		async (k) => {
			await buildPinDevice();
			const before = await snapshot();
			const expected = await confirmNow();

			const result = await restoreLockedDevice(
				db,
				fileInner(),
				expected,
				run({
					afterPut: (index) => {
						if (index === k) throw new Error('E_TEST_CRASH');
					}
				}).options
			);

			expect(result).toStrictEqual({ ok: false, code: 'E_WRITE_FAILED' });
			expect(await snapshot()).toStrictEqual(before);
			// Still the device it was: locked behind its PIN, with the tries it had.
			expect(need(await readRaw('keystore')).mode).toBe('pin');
			expect(await readLockedDevice(db)).toMatchObject({ gens: DEVICE });
		}
	);

	describe('on success', () => {
		/** A device behind a forgotten PIN, restored from the backup; what the tests below look at afterwards. */
		async function restoreOnce(over: { clockBehindMs?: number } = {}) {
			const { session: oldSession } = await buildPinDevice();
			const oldRow = need(await readRaw('keystore')) as KeystoreRow;
			const oldMarkTimes = await markerTimes();
			const counterBefore = await readCounter(db);
			const expected = await confirmNow();
			const behind = over.clockBehindMs;
			const { options, onCommitting } = run(
				behind === undefined ? {} : { now: () => Math.min(...oldMarkTimes) - behind }
			);
			const gens = expectSucceeded(await restoreLockedDevice(db, fileInner(), expected, options));
			return { oldSession, oldRow, oldMarkTimes, counterBefore, gens, onCommitting };
		}

		it('writes a fresh local keystore one step past the PIN row, under keys that verify it', async () => {
			const { oldRow, onCommitting } = await restoreOnce();

			expect(onCommitting).toHaveBeenCalledTimes(1);
			const row = (await readKeystoreRow(db)).row;
			expect(row.mode).toBe('local');
			expect(hex(row.installUuid)).not.toBe(hex(oldRow.installUuid));
			expect(row.keystoreGeneration).toBe(oldRow.keystoreGeneration + 1);
			expect(row.epoch).toBe(oldRow.epoch + 1);
			expect(row.ivCounter).toBe(1);
			expect(await verifyKeystore(row, keysForRow(row))).toBe(true);
		});

		it('writes the whole transaction at once, durable, over every store', async () => {
			await buildPinDevice();
			const expected = await confirmNow();
			const original = IDBDatabase.prototype.transaction;
			const seen: { mode: IDBTransactionMode; durability: string; stores: string[] }[] = [];
			vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
				this: IDBDatabase,
				stores: string | Iterable<string>,
				mode?: IDBTransactionMode,
				options?: IDBTransactionOptions
			) {
				const tx = original.call(this, stores, mode, options);
				seen.push({ mode: tx.mode, durability: tx.durability, stores: [...tx.objectStoreNames] });
				return tx;
			});

			expectSucceeded(await restoreLockedDevice(db, fileInner(), expected, run().options));

			const writes = seen.filter((tx) => tx.mode !== 'readonly');
			expect(writes).toHaveLength(1);
			expect(writes[0]?.durability).toBe('strict');
			expect([...(writes[0]?.stores ?? [])].sort()).toStrictEqual([...STORES].sort());
		});

		it('opens every store with the backup content, each one step past the old marks', async () => {
			const { gens } = await restoreOnce();

			expect(gens).toStrictEqual({
				profile: DEVICE.profile + 1,
				timeline: DEVICE.timeline + 1,
				calendar: DEVICE.calendar + 1,
				finder: DEVICE.finder + 1
			});
			// The app opens it the way a reload does.
			const profile = createProfileStore(db);
			const loaded = need(await profile.load());
			expect(decodeEaos(need(loaded.eaos))).toBe('2028-02-01');
			expect(decodeEaos(need(loaded.terminalLeaveStart))).toBe('2028-01-01');
			expect(loaded.generation).toBe(DEVICE.profile + 1);
			const timeline = createTimelineStateStore(db);
			await timeline.load();
			expect(timeline.state).toEqual(FILE_TIMELINE);
			const calendar = createCalendarSyncStore(db);
			await calendar.load();
			expect(calendar.exclusions).toEqual({ taskIds: ['will-poa'], categories: ['finance'] });
			expect(calendar.card).toEqual({ dismissedAt: NOW, dismissCount: 2 });
			const finder = createFinderStore(db);
			await finder.load();
			expect(finder.saved).toEqual(FILE_FINDER.finderSaved);
			expect(finder.compare).toEqual(FILE_FINDER.finderCompare);
			const state = await readDeviceState(db);
			expect(state.gens).toStrictEqual(gens);
			expect(state.mark?.gens).toStrictEqual(gens);
		});

		it('signs the four markers for the new keystore and the restore time, under its own key', async () => {
			const { gens, oldMarkTimes } = await restoreOnce({ clockBehindMs: DAY });

			const { row, keys } = await readKeystoreRow(db);
			const at = Math.min(...oldMarkTimes) - DAY;
			const marked = [
				['profile-hwm', gens.profile],
				['timeline-state-hwm', gens.timeline],
				['calendar-sync-hwm', gens.calendar],
				['skillbridge-finder-hwm', gens.finder]
			] as const;
			for (const [store, generation] of marked) {
				const marker = need(await readRaw(store)) as unknown as SignedSidecar<ProfileHwmPayload>;
				expect(marker.payload).toStrictEqual({
					generation,
					keystoreGeneration: row.keystoreGeneration,
					epoch: row.epoch,
					ts: at
				});
				await expect(
					verifySidecar(store, { v: 1, payload: marker.payload, mac: marker.mac }, keys.hmacKey)
				).resolves.toStrictEqual(marker.payload);
			}
		});

		it('empties what a restore cannot carry over: the API key, cached finder files and wrong tries', async () => {
			const { counterBefore } = await restoreOnce();

			expect(await rowsOf('byok')).toStrictEqual([]);
			expect(await rowsOf(PACK)).toStrictEqual([]);
			expect(await readTries(db)).toStrictEqual({ count: 0, waitMs: 0, pending: false });
			expect(await rowsOf('app-lock')).toStrictEqual([{ id: 'counter', value: counterBefore + 1 }]);
		});

		it('puts out a tab that was open on the PIN: its next key read finds its row gone', async () => {
			const { oldSession } = await restoreOnce();
			const row = (await readKeystoreRow(db)).row;

			setSession(oldSession);

			await expect(readKeystoreRow(db)).rejects.toBeInstanceOf(KeystoreLockedError);
			expect(getSession()).toBeNull();
			// Its keys and identity belong to the PIN row, not the new one.
			expect(keyIdentity(row)).not.toStrictEqual(oldSession.identity);
		});

		it('never sets the clock mark below the newest write time the locked device showed', async () => {
			// A clock a month behind the device's own marks: the mark may stay where it was, never go back.
			const { oldMarkTimes } = await restoreOnce({ clockBehindMs: 30 * DAY });

			const loaded = need(await createProfileStore(db).load());
			expect(loaded.lastSeenAt).toBe(Math.max(...oldMarkTimes));
		});

		it('keeps going from the restored record: the next saves go through', async () => {
			await buildPinDevice();
			expectSucceeded(
				await restoreLockedDevice(db, fileInner(), await confirmNow(), run().options)
			);

			const profile = createProfileStore(db);
			await profile.load();
			const timeline = createTimelineStateStore(db);
			await timeline.load();
			const calendar = createCalendarSyncStore(db);
			await calendar.load();

			await profile.save({ yearsOfService: 9 });
			await timeline.setStatus('will-poa', 'done');
			await calendar.setExclusions({ taskIds: [], categories: [] });
		});
	});

	describe('refuses, writing nothing', () => {
		const refuse = async (
			expected: Awaited<ReturnType<typeof confirmNow>>,
			code: string
		): Promise<void> => {
			const before = await snapshot();
			const { options, onCommitting } = run();

			const result = await restoreLockedDevice(db, fileInner(), expected, options);

			expect(result).toStrictEqual({ ok: false, code });
			expect(onCommitting).not.toHaveBeenCalled();
			expect(await snapshot()).toStrictEqual(before);
		};

		it('a device that is no longer behind a PIN (the PIN was removed from another tab)', async () => {
			await bootstrapLocalKeystore(db);
			const row = need(await readRaw('keystore'));

			await refuse(
				{
					gens: { profile: 0, timeline: 0, calendar: 0, finder: 0 },
					installUuid: new Uint8Array(row.installUuid as Uint8Array)
				},
				'E_RESTORE_DEVICE_CHANGED'
			);
		});

		it('another install than the one the person confirmed against', async () => {
			await buildPinDevice();
			const expected = await confirmNow();
			const other = new Uint8Array(expected.installUuid);
			other[0] = (other[0] ?? 0) ^ 1;

			await refuse({ ...expected, installUuid: other }, 'E_RESTORE_DEVICE_CHANGED');
		});

		it.each(['profile', 'timeline', 'calendar', 'finder'] as const)(
			'a device whose %s generation moved since the confirm',
			async (which) => {
				await buildPinDevice();
				const expected = await confirmNow();

				await refuse(
					{ ...expected, gens: { ...expected.gens, [which]: expected.gens[which] + 1 } },
					'E_RESTORE_DEVICE_MOVED'
				);
			}
		);

		it('a session that no longer allows the write', async () => {
			await buildPinDevice();
			const before = await snapshot();
			const expected = await confirmNow();
			const { options, onCommitting } = run({ mayCommit: () => false });

			await expect(restoreLockedDevice(db, fileInner(), expected, options)).rejects.toBeInstanceOf(
				RunAbortedError
			);

			expect(onCommitting).not.toHaveBeenCalled();
			expect(await snapshot()).toStrictEqual(before);
		});

		it('a run that was cancelled before the write', async () => {
			await buildPinDevice();
			const before = await snapshot();
			const expected = await confirmNow();
			const { options, ctl } = run();
			ctl.abort();

			await expect(restoreLockedDevice(db, fileInner(), expected, options)).rejects.toBeInstanceOf(
				RunAbortedError
			);

			expect(await snapshot()).toStrictEqual(before);
		});
	});

	describe('plaintext left in memory', () => {
		it.each([
			['completes', undefined],
			[
				'fails after everything was composed',
				(index: number) => {
					if (index === 3) throw new Error('E_TEST_CRASH');
				}
			]
		] as const)('is wiped when the restore %s', async (_what, crash) => {
			await buildPinDevice();
			const expected = await confirmNow();
			// Made before the seam is armed: the file's own text is not the restore's to wipe.
			const inner = fileInner();
			seams.capture = true;

			await restoreLockedDevice(db, inner, expected, run({ afterPut: crash }).options);
			seams.capture = false;

			// The composer's own check encodes the profile as text; every one of those buffers reads zero now.
			expect(seams.encoded.length).toBeGreaterThan(0);
			for (const bytes of seams.encoded) {
				expect(bytes.length).toBeGreaterThan(0);
				expect(bytes.every((byte) => byte === 0)).toBe(true);
			}
			// Generation 41 is the profile decoded from the file; the next one is the composed record.
			for (const generation of [FILE_GENERATION, DEVICE.profile + 1]) {
				const records = seams.zeroized.filter((rec) => rec.generation === generation);
				expect(records.length).toBeGreaterThan(0);
				for (const rec of records) {
					const eaos = rec.eaos as Uint8Array;
					expect(eaos.length).toBeGreaterThan(0);
					expect(eaos.every((byte) => byte === 0)).toBe(true);
				}
			}
		});
	});
});
