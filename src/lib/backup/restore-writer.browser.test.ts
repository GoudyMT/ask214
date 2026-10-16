import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import { LOCK_TIMEOUT_MS, LockAcquisitionTimeout, RunAbortedError } from '../db/locks';
import { withStores, reqToPromise, STORES, type StoreName } from '../db/schema';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { createProfileStore, OccConflictError, readDeviceState } from '../profile/store.svelte';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { createByokStore } from '../ask/byok/store';
import { signSidecar } from '../profile/sidecars';
import { encodeProfile } from '../profile/codec';
import { decodeEaos, encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { KNOWN_TASK_IDS } from '../timeline/known-task-ids';
import type { CalendarSyncState, DesiredEvent } from '../calendar/types';
import type { TimelineState } from '../timeline/types';
import {
	restoreBackup,
	type RestoreExpected,
	type RestoreGens,
	type RestoreOptions,
	type RestoreResult
} from './restore-writer';
import { validateInner, type ValidInner } from './validate';

// Seams over four modules, each a passthrough until a test arms it. The paths are `$lib` aliases on purpose: with a
// relative path a mock silently never applied to the writer's own import in this browser runner.
// - decodeProfile can add a field to the profile it decodes from the FILE (a composer that invents content);
// - encodeCalendarSyncState can drop the card (a codec that does not round-trip what it was given);
// - signSidecar reports each finished signature, so a test can act in the last wait before the transaction;
// - zeroizeRecord keeps every record it wipes, so a test can look at what the writer left behind;
// - the timeline and calendar encoders keep every buffer they hand out, so a test can see which were wiped.
const seams = vi.hoisted(() => ({
	inventOnGeneration: -1,
	dropCard: false,
	onSigned: null as (() => void) | null,
	zeroized: [] as Record<string, unknown>[],
	encoded: [] as Uint8Array[]
}));

vi.mock('$lib/profile/codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/codec')>();
	return {
		...real,
		decodeProfile: (bytes: Uint8Array) => {
			const out = real.decodeProfile(bytes);
			if (out.generation === seams.inventOnGeneration) out.yearsOfService = 99;
			return out;
		}
	};
});

vi.mock('$lib/calendar/codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('../calendar/codec')>();
	return {
		...real,
		encodeCalendarSyncState: (state: CalendarSyncState) => {
			const out = real.encodeCalendarSyncState(
				seams.dropCard
					? (Object.fromEntries(
							Object.entries(state).filter(([key]) => key !== 'card')
						) as CalendarSyncState)
					: state
			);
			seams.encoded.push(out);
			return out;
		}
	};
});

vi.mock('$lib/timeline/state-codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('../timeline/state-codec')>();
	return {
		...real,
		encodeTimelineState: (state: TimelineState) => {
			const out = real.encodeTimelineState(state);
			seams.encoded.push(out);
			return out;
		}
	};
});

vi.mock('$lib/profile/sidecars', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/sidecars')>();
	return {
		...real,
		signSidecar: async <T>(name: string, payload: T, key: CryptoKey) => {
			const signed = await real.signSidecar(name, payload, key);
			seams.onSigned?.();
			return signed;
		}
	};
});

vi.mock('$lib/profile/lifecycle', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/lifecycle')>();
	return {
		...real,
		zeroizeRecord: (rec: Record<string, unknown>): void => {
			seams.zeroized.push(rec);
			real.zeroizeRecord(rec);
		}
	};
});

type Bag = Record<string, unknown>;
type Row = Record<string, unknown>;

const NOW = Date.now();
const DAY = 86_400_000;
// A generation no device record in this file ever has, so a seam can tell the file's profile from the device's.
const FILE_GENERATION = 41;
const INVENTED_GENERATION = 1234;
const DEVICE: RestoreGens = { profile: 3, timeline: 4, calendar: 2 };
const SEVEN: StoreName[] = STORES.filter((store) => store !== 'byok');

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	seams.inventOnGeneration = -1;
	seams.dropCard = false;
	seams.onSigned = null;
	seams.zeroized.length = 0;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await deleteTestDb(db);
});

function need<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error('test setup: value missing');
	return value;
}

const taskId = (i: number): string => need(KNOWN_TASK_IDS[i % 8]);

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

const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A row as plain text, bytes included, so two reads can be compared. A stored key cannot be read, so it is a label. */
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

/** All eight stores, byok included, as a person's device holds them right now. */
async function snapshot(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const store of STORES) out[store] = plain(await readRaw(store));
	return out;
}

/** A device built the way a person builds one: real stores, real saves, until the generations are these. */
async function buildDevice(gens: RestoreGens = DEVICE, opts: { lastAdd?: boolean } = {}) {
	await bootstrapLocalKeystore(db);
	const profile = createProfileStore(db);
	for (let i = 0; i < gens.profile; i++) {
		await profile.save(
			i === 0
				? { setupIntent: 'completed', eaos: encodeEaos(parseEaosAtRead('2027-04-15')) }
				: { yearsOfService: i }
		);
	}
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	for (let i = 0; i < gens.timeline; i++) {
		await timeline.setStatus(taskId(i), i % 2 === 0 ? 'done' : 'skipped');
	}
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	for (let i = 0; i < gens.calendar; i++) {
		if (opts.lastAdd && i === gens.calendar - 1) {
			const event: DesiredEvent = {
				taskId: taskId(2),
				moment: 'opens',
				title: 'Start the VA account',
				isoDate: '2999-01-01',
				alarmDays: [1]
			};
			await calendar.recordAdd([event], '2026-10-16', '2026-10-16');
		} else {
			await calendar.setExclusions({ taskIds: [taskId(i + 3)], categories: [] });
		}
	}
	return { profile, timeline, calendar };
}

/** What the confirm shows: the generations on this device and its install, read just now. */
async function confirmNow(): Promise<RestoreExpected> {
	const keystore = need(await readRaw('keystore'));
	const state = await readDeviceState(db);
	return { gens: state.gens, installUuid: new Uint8Array(keystore.installUuid as Uint8Array) };
}

type FileOptions = {
	generation?: number;
	lastSeenAt?: number;
	createdAt?: number;
	eaos?: string;
	timeline?: Bag | null;
	calendar?: Bag | null;
};

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

/** A backup made on another phone, run through the real validator. */
function fileInner(o: FileOptions = {}): ValidInner {
	const date = (iso: string) => encodeEaos(parseEaosAtRead(iso));
	const profile = JSON.parse(
		new TextDecoder().decode(
			encodeProfile({
				schemaVersion: 1,
				generation: o.generation ?? FILE_GENERATION,
				lastSeenAt: o.lastSeenAt ?? NOW - 40 * DAY,
				setupIntent: 'completed',
				setupIntentChangedAt: NOW - 90 * DAY,
				eaos: date(o.eaos ?? '2028-02-01'),
				terminalLeaveStart: date('2028-01-01')
			})
		)
	) as Bag;
	const file = JSON.parse(
		JSON.stringify({
			appVersion: __APP_VERSION__,
			backupSchema: 1,
			createdAt: o.createdAt ?? NOW - 5 * DAY,
			stores: {
				profile,
				'timeline-state': o.timeline === undefined ? FILE_TIMELINE : o.timeline,
				'calendar-sync': o.calendar === undefined ? FILE_CALENDAR : o.calendar
			}
		})
	) as unknown;
	const checked = validateInner(file);
	if (!checked.ok) throw new Error('test setup: the file does not validate');
	return checked.inner;
}

type Session = {
	ctl: AbortController;
	mayCommit: ReturnType<typeof vi.fn<() => boolean>>;
	onCommitting: ReturnType<typeof vi.fn<() => void>>;
	options: RestoreOptions;
};

/** The session a later unit supplies: a run signal and the two callbacks, with the clock fixed unless a test moves it. */
function session(over: { now?: () => number; mayCommit?: () => boolean } = {}): Session {
	const ctl = new AbortController();
	const mayCommit = vi.fn(over.mayCommit ?? (() => true));
	const onCommitting = vi.fn<() => void>();
	return {
		ctl,
		mayCommit,
		onCommitting,
		options: { signal: ctl.signal, mayCommit, onCommitting, now: over.now ?? (() => NOW) }
	};
}

/** The IndexedDB puts made from now on, by store name, with an optional hook that runs before each one. */
function watchPuts(beforePut?: (count: number) => void): string[] {
	const original = IDBObjectStore.prototype.put;
	const stores: string[] = [];
	vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey
	) {
		stores.push(this.name);
		beforePut?.(stores.length);
		return original.call(this, value, key);
	});
	return stores;
}

function expectSucceeded(result: RestoreResult): RestoreGens {
	expect(result).toMatchObject({ ok: true });
	if (!result.ok) throw new Error('E_TEST_RESTORE_FAILED');
	return result.gens;
}

describe('restoreBackup', () => {
	it('reload proof: a device at 5 / 9 / 2 restores a file made elsewhere and opens ready with its content', async () => {
		await buildDevice({ profile: 5, timeline: 9, calendar: 2 });
		const expected = await confirmNow();
		expect(expected.gens).toEqual({ profile: 5, timeline: 9, calendar: 2 });
		// The file claims a lastSeenAt a year ahead and its own generation: neither may reach the device.
		const inner = fileInner({ generation: 1, lastSeenAt: NOW + 365 * DAY });
		const { options } = session({ now: () => Date.now() });

		const gens = expectSucceeded(await restoreBackup(db, inner, expected, options));
		expect(gens).toEqual({ profile: 6, timeline: 10, calendar: 3 });

		// A reload: new stores over the same database.
		const profile = createProfileStore(db);
		const loaded = need(await profile.load());
		expect(decodeEaos(need(loaded.eaos))).toBe('2028-02-01');
		expect(decodeEaos(need(loaded.terminalLeaveStart))).toBe('2028-01-01');
		expect(loaded.generation).toBe(6);
		expect(profile.clockBackward).toBe(false);
		const timeline = createTimelineStateStore(db);
		await timeline.load();
		expect(timeline.ready).toBe(true);
		expect(timeline.state).toEqual(FILE_TIMELINE);
		const calendar = createCalendarSyncStore(db);
		await calendar.load();
		expect(calendar.ready).toBe(true);
		expect(calendar.exclusions).toEqual({ taskIds: ['will-poa'], categories: ['finance'] });
		expect(calendar.card).toEqual({ dismissedAt: NOW, dismissCount: 2 });
		expect((await readDeviceState(db)).gens).toEqual({ profile: 6, timeline: 10, calendar: 3 });

		// The person carries on: the next saves go through.
		await profile.save({ yearsOfService: 9 });
		await timeline.setStatus('will-poa', 'done');
		await calendar.setExclusions({ taskIds: [], categories: [] });
	});

	it('restore keeps a device lastSeenAt that is ahead of the clock', async () => {
		const ahead = NOW + 30 * DAY;
		const clock = vi.spyOn(Date, 'now').mockReturnValue(ahead);
		await buildDevice();
		clock.mockRestore();
		// A later save on the right clock: the record keeps the high mark, while the mark's own time is now the real one.
		const later = createProfileStore(db);
		await later.load();
		await later.save({ yearsOfService: 2 });
		const state = await readDeviceState(db);
		expect(state.lastSeenAt).toBe(ahead);
		expect(need(state.ts.profile)).toBeLessThan(ahead);
		const expected = await confirmNow();

		expectSucceeded(await restoreBackup(db, fileInner(), expected, session().options));

		const profile = createProfileStore(db);
		const loaded = need(await profile.load());
		expect(decodeEaos(need(loaded.eaos))).toBe('2028-02-01');
		expect(loaded.lastSeenAt).toBe(ahead);
		// The clock-backward warning the device already had is still there.
		expect(profile.clockBackward).toBe(true);
	});

	it("restore never takes the file's lastSeenAt", async () => {
		await buildDevice();
		const expected = await confirmNow();
		const fileLastSeen = NOW + 200 * DAY;

		const inner = fileInner({ lastSeenAt: fileLastSeen });
		expectSucceeded(await restoreBackup(db, inner, expected, session().options));

		const loaded = need(await createProfileStore(db).load());
		expect(decodeEaos(need(loaded.eaos))).toBe('2028-02-01');
		expect(loaded.lastSeenAt).toBeLessThan(fileLastSeen);
		expect(loaded.lastSeenAt).toBeGreaterThanOrEqual(NOW - DAY);
	});

	it.each([
		['a past createdAt is kept', NOW - 5 * DAY, NOW - 5 * DAY],
		['a future createdAt is clamped to now', NOW + 10 * DAY, NOW]
	])(
		'restore writes lastBackupAt = min(createdAt, now) and the three new generations: %s',
		async (_name, createdAt, lastBackupAt) => {
			await buildDevice();
			const expected = await confirmNow();

			await restoreBackup(db, fileInner({ createdAt }), expected, session().options);

			expect((await readDeviceState(db)).mark).toEqual({
				at: lastBackupAt,
				gens: { profile: 4, timeline: 5, calendar: 3 }
			});
		}
	);

	it("restore keeps the device's lastAdd", async () => {
		const device = await buildDevice(DEVICE, { lastAdd: true });
		const before = need(device.calendar.lastAdd);
		expect(before).toHaveLength(1);
		const expected = await confirmNow();

		await restoreBackup(db, fileInner(), expected, session().options);

		const calendar = createCalendarSyncStore(db);
		await calendar.load();
		expect(calendar.lastAdd).toEqual(before);
		// The file's own content came with it.
		expect(calendar.exclusions).toEqual({ taskIds: ['will-poa'], categories: ['finance'] });
	});

	it('an unreadable device calendar body writes lastAdd absent and still restores', async () => {
		await buildDevice(DEVICE, { lastAdd: true });
		await putRaw('calendar-sync', { id: 0, rec: new Uint8Array(64).fill(7) });
		const expected = await confirmNow();

		const result = await restoreBackup(db, fileInner(), expected, session().options);

		expect(result.ok).toBe(true);
		const calendar = createCalendarSyncStore(db);
		await calendar.load();
		expect(calendar.lastAdd).toBeUndefined();
		expect(calendar.exclusions).toEqual({ taskIds: ['will-poa'], categories: ['finance'] });
	});

	it('a null timeline in the file writes an empty record at +1', async () => {
		await buildDevice();
		const expected = await confirmNow();

		await restoreBackup(db, fileInner({ timeline: null }), expected, session().options);

		expect((await readDeviceState(db)).gens.timeline).toBe(DEVICE.timeline + 1);
		const timeline = createTimelineStateStore(db);
		await timeline.load();
		expect(timeline.ready).toBe(true);
		expect(timeline.state).toEqual({ schemaVersion: 1, tasks: {} });
	});

	it('a null calendar in the file writes an empty record at +1', async () => {
		await buildDevice();
		const expected = await confirmNow();

		await restoreBackup(db, fileInner({ calendar: null }), expected, session().options);

		expect((await readDeviceState(db)).gens.calendar).toBe(DEVICE.calendar + 1);
		const calendar = createCalendarSyncStore(db);
		await calendar.load();
		expect(calendar.ready).toBe(true);
		expect(calendar.exclusions).toEqual({ taskIds: [], categories: [] });
	});

	it('the restore bumps ivCounter exactly once', async () => {
		await buildDevice();
		const before = need(await readRaw('keystore'));
		const expected = await confirmNow();

		await restoreBackup(db, fileInner(), expected, session().options);

		const after = need(await readRaw('keystore'));
		expect(after.ivCounter).toBe((before.ivCounter as number) + 1);
		// Everything else a record is bound to stays as it was, and the record still verifies on load.
		for (const key of ['installUuid', 'keystoreGeneration', 'epoch'] as const) {
			expect(plain(after[key])).toEqual(plain(before[key]));
		}
		need(await createProfileStore(db).load());
	});

	it('the stored API key is still readable after a restore, and its row is untouched', async () => {
		await buildDevice();
		await createByokStore(db).saveApiKey('sk-ant-api03-test-key-0000');
		const byokBefore = plain(await readRaw('byok'));
		const expected = await confirmNow();

		expectSucceeded(await restoreBackup(db, fileInner(), expected, session().options));

		expect(await createByokStore(db).readApiKey()).toBe('sk-ant-api03-test-key-0000');
		expect(plain(await readRaw('byok'))).toEqual(byokBefore);
	});

	it('the device moved since the confirm returns DEVICE_MOVED and writes nothing', async () => {
		await buildDevice();
		const expected = await confirmNow();
		const { options, onCommitting } = session();
		let restoring: Promise<RestoreResult> | undefined;
		let before: Record<string, unknown> = {};

		// Another tab saves while the restore waits its turn for the lock. It must be read AFTER the wait.
		await navigator.locks.request('mtc-keystore', { mode: 'exclusive' }, async () => {
			restoring = restoreBackup(db, fileInner(), expected, options);
			const keystore = need(await readRaw('keystore'));
			const peerMark = await signSidecar(
				'timeline-state-hwm',
				{ generation: DEVICE.timeline + 1, keystoreGeneration: 0, epoch: 0, ts: NOW },
				keystore.hmacKeyRef as CryptoKey
			);
			await putRaw('timeline-state-hwm', { id: 0, ...peerMark });
			before = await snapshot();
		});

		expect(await restoring).toEqual({ ok: false, code: 'E_RESTORE_DEVICE_MOVED' });
		expect(await snapshot()).toEqual(before);
		expect(onCommitting).not.toHaveBeenCalled();
	});

	it.each([
		[
			'another tab erased and set up again',
			async () => {
				await withStores(db, SEVEN, 'readwrite', (tx) => {
					for (const store of SEVEN) tx.objectStore(store).clear();
				});
				await bootstrapLocalKeystore(db);
			}
		],
		[
			'another tab erased and has not set up yet',
			async () => {
				await withStores(db, SEVEN, 'readwrite', (tx) => {
					for (const store of SEVEN) tx.objectStore(store).clear();
				});
			}
		]
	])('%s returns DEVICE_CHANGED and writes nothing', async (_name, erase) => {
		await buildDevice();
		const expected = await confirmNow();
		await erase();
		const before = await snapshot();
		const { options, onCommitting } = session();

		const result = await restoreBackup(db, fileInner(), expected, options);

		expect(result).toEqual({ ok: false, code: 'E_RESTORE_DEVICE_CHANGED' });
		expect(await snapshot()).toEqual(before);
		expect(onCommitting).not.toHaveBeenCalled();
	});

	it.each([
		[
			'a tampered device sidecar',
			async (expected: RestoreExpected) => {
				const row = need(await readRaw('timeline-state-hwm'));
				const payload = row.payload as Bag;
				await putRaw('timeline-state-hwm', { ...row, payload: { ...payload, generation: 99 } });
				return expected;
			}
		],
		[
			// The app calls this device damaged on every load, so a restore must not paper over it: a second tab would
			// then save over the restored data. A confirm built on it reads the missing mark as generation 0.
			'a profile mark that is missing',
			async (expected: RestoreExpected) => {
				await withStores(db, 'profile-hwm', 'readwrite', (tx) => {
					tx.objectStore('profile-hwm').clear();
				});
				return { ...expected, gens: { ...expected.gens, profile: 0 } };
			}
		],
		[
			'a tampered keystore row',
			async (expected: RestoreExpected) => {
				await putRaw('keystore', { ...need(await readRaw('keystore')), epoch: 1 });
				return expected;
			}
		]
	])('%s returns DEVICE_DAMAGED and writes nothing', async (_name, damage) => {
		await buildDevice();
		const expected = await damage(await confirmNow());
		const before = await snapshot();
		const { options, onCommitting } = session();

		const result = await restoreBackup(db, fileInner(), expected, options);

		expect(result).toEqual({ ok: false, code: 'E_RESTORE_DEVICE_DAMAGED' });
		expect(await snapshot()).toEqual(before);
		expect(onCommitting).not.toHaveBeenCalled();
	});

	it('an abort while the restore waits for the lock stops it at once and writes nothing', async () => {
		await buildDevice();
		const expected = await confirmNow();
		const before = await snapshot();
		const s = session();

		// The keystore lock is held (a save or an erase in another tab), so the restore is queued behind it. The abort
		// must withdraw the request: waiting for the lock to free would leave the person's cancel unanswered.
		await navigator.locks.request('mtc-keystore', { mode: 'exclusive' }, async () => {
			const restoring = restoreBackup(db, fileInner(), expected, s.options);
			s.ctl.abort();
			await expect(restoring).rejects.toBeInstanceOf(RunAbortedError);
		});

		expect(await snapshot()).toEqual(before);
		expect(s.onCommitting).not.toHaveBeenCalled();
	});

	it('an abort between step 1 and step 7 writes nothing: mayCommit false at the commit check', async () => {
		await buildDevice();
		const expected = await confirmNow();
		const before = await snapshot();
		const s = session({ mayCommit: () => false });

		await expect(restoreBackup(db, fileInner(), expected, s.options)).rejects.toBeInstanceOf(
			RunAbortedError
		);

		expect(await snapshot()).toEqual(before);
		expect(s.onCommitting).not.toHaveBeenCalled();
	});

	it('the step-7 check runs after the last wait: an abort queued by the last await before the transaction stops the write', async () => {
		await buildDevice();
		const expected = await confirmNow();
		const before = await snapshot();
		const s = session();
		let signed = 0;
		seams.onSigned = () => {
			// The third signature is the last wait; the abort lands before the writer wakes up from it.
			if (++signed === 3) queueMicrotask(() => s.ctl.abort());
		};

		await expect(restoreBackup(db, fileInner(), expected, s.options)).rejects.toBeInstanceOf(
			RunAbortedError
		);

		expect(signed).toBe(3);
		expect(await snapshot()).toEqual(before);
		expect(s.onCommitting).not.toHaveBeenCalled();
	});

	it('the deadline firing at step 6 leaves the 7 rows byte-identical and byok untouched', async () => {
		await buildDevice();
		await createByokStore(db).saveApiKey('sk-ant-api03-test-key-0000');
		const expected = await confirmNow();
		const before = await snapshot();
		const s = session();
		let signed = 0;
		// The session's deadline fires while the writer is encrypting and signing, after every read and before the transaction.
		seams.onSigned = () => {
			if (++signed === 1) s.ctl.abort();
		};

		await expect(restoreBackup(db, fileInner(), expected, s.options)).rejects.toBeInstanceOf(
			RunAbortedError
		);

		expect(signed).toBeGreaterThan(0);
		expect(await snapshot()).toEqual(before);
		expect(s.onCommitting).not.toHaveBeenCalled();
		expect(await createByokStore(db).readApiKey()).toBe('sk-ant-api03-test-key-0000');
	});

	it('the step-7 check and the puts run in one synchronous block: an abort queued at the check lands after all seven puts', async () => {
		await buildDevice();
		const expected = await confirmNow();
		const s = session();
		s.mayCommit.mockImplementation(() => {
			queueMicrotask(() => s.ctl.abort());
			return true;
		});
		const abortedAtPut: boolean[] = [];
		const stores = watchPuts(() => abortedAtPut.push(s.ctl.signal.aborted));

		const result = await restoreBackup(db, fileInner(), expected, s.options);

		expect(result.ok).toBe(true);
		expect([...stores].sort()).toEqual([...SEVEN].sort());
		expect(abortedAtPut).toEqual(new Array<boolean>(7).fill(false));
		expect(s.onCommitting).toHaveBeenCalledTimes(1);
	});

	it("the commit check's throw reaches the caller as RunAbortedError, not a lock timeout", async () => {
		await buildDevice();
		const expected = await confirmNow();
		const s = session({ mayCommit: () => false });

		const failure = await restoreBackup(db, fileInner(), expected, s.options).catch(
			(e: unknown) => e
		);

		expect(failure).toBeInstanceOf(RunAbortedError);
		expect(failure).not.toBeInstanceOf(LockAcquisitionTimeout);
	});

	it('abort after the 2nd put leaves the 7 rows byte-identical and byok untouched', async () => {
		await buildDevice();
		await createByokStore(db).saveApiKey('sk-ant-api03-test-key-0000');
		const expected = await confirmNow();
		const before = await snapshot();
		const s = session();
		watchPuts((count) => {
			if (count === 3) throw new Error('E_TEST_THIRD_PUT');
		});

		const result = await restoreBackup(db, fileInner(), expected, s.options);

		expect(result).toEqual({ ok: false, code: 'E_WRITE_FAILED' });
		// The transaction was opened and two puts went in before the third failed: that is what must leave no trace.
		expect(s.onCommitting).toHaveBeenCalledTimes(1);
		expect(await snapshot()).toEqual(before);
	});

	it.each([
		[
			'the composer adds content the file does not hold',
			() => {
				seams.inventOnGeneration = INVENTED_GENERATION;
			}
		],
		[
			'a codec does not give back what it was handed',
			() => {
				seams.dropCard = true;
			}
		]
	])(
		'a composed record whose content differs from the validated file fails before step 8, rows unchanged: %s',
		async (_name, injectBug) => {
			await buildDevice();
			const expected = await confirmNow();
			const inner = fileInner({ generation: INVENTED_GENERATION });
			const before = await snapshot();
			const s = session();
			injectBug();

			const result = await restoreBackup(db, inner, expected, s.options);

			expect(result).toEqual({ ok: false, code: 'E_WRITE_FAILED' });
			expect(await snapshot()).toEqual(before);
			expect(s.mayCommit).not.toHaveBeenCalled();
		}
	);

	it('a stale peer save after the restore gets OccConflictError', async () => {
		const device = await buildDevice();
		const expected = await confirmNow();

		await restoreBackup(db, fileInner(), expected, session().options);

		// This store loaded the profile before the restore, as a second tab would have.
		await expect(device.profile.save({ yearsOfService: 8 })).rejects.toBeInstanceOf(
			OccConflictError
		);
	});

	it.each([
		['finishes', () => {}],
		[
			'fails on a put',
			() => {
				watchPuts((count) => {
					if (count === 3) throw new Error('E_TEST_THIRD_PUT');
				});
			}
		]
	])('the restore wipes what it staged when it %s', async (_name, arm) => {
		await buildDevice();
		const expected = await confirmNow();
		const inner = fileInner();
		seams.zeroized.length = 0;
		seams.encoded.length = 0;
		arm();

		await restoreBackup(db, inner, expected, session().options);

		// Every timeline and calendar buffer made for the restore (the writer's own check and the boundaries' copies)
		// holds the person's notes and settings as text, so none may be left readable.
		expect(seams.encoded.length).toBeGreaterThanOrEqual(4);
		for (const bytes of seams.encoded) {
			expect(bytes.length).toBeGreaterThan(0);
			expect(bytes.every((byte) => byte === 0)).toBe(true);
		}

		// Generation 41 is the profile decoded from the file; 4 is the composed record (the device was at 3).
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

	it('it finishes well under LOCK_TIMEOUT_MS', async () => {
		await buildDevice();
		const expected = await confirmNow();
		const started = performance.now();

		const result = await restoreBackup(db, fileInner(), expected, session().options);

		expect(result.ok).toBe(true);
		expect(performance.now() - started).toBeLessThan(LOCK_TIMEOUT_MS / 2);
	});
});
