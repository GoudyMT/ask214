import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMtcDb, reqToPromise, withStores } from '../db/schema';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { LockAcquisitionTimeout } from '../db/locks';
import { wipeAllStores } from '../db/wipe';
import {
	TRIES_LOCK_NAME,
	bumpCounter,
	bumpCounterIn,
	clearTriesIn,
	createWaitClock,
	readCounter,
	readTries,
	readTriesWithId,
	runPinCheck,
	waitAfterWrongTries,
	type PinCheckResult,
	type TriesState
} from './app-lock-store';

// Real IndexedDB and real Web Locks in Chromium. Each test opens a uniquely named database and deletes it afterwards.
let opened: IDBDatabase[] = [];
let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	opened.push(db);
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const open of opened) await deleteTestDb(open);
	opened = [];
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Writes the wrong-try row directly, the way a tab killed mid-check leaves it. */
function putTries(row: Record<string, unknown>): Promise<void> {
	return withStores(db, 'app-lock', 'readwrite', (tx) => {
		tx.objectStore('app-lock').put({ id: 'tries', ...row });
	});
}

function rawRows(): Promise<Record<string, unknown>[]> {
	return withStores(db, 'app-lock', 'readonly', (tx) =>
		reqToPromise<Record<string, unknown>[]>(tx.objectStore('app-lock').getAll())
	);
}

const wrong = async (): Promise<PinCheckResult<never>> => ({ kind: 'wrong' });

/** The count and the wait id of the stored row. */
async function readWaitId(database: IDBDatabase): Promise<{ count: number; waitId: number }> {
	const { count, waitId } = await readTriesWithId(database);
	return { count, waitId };
}

describe('waitAfterWrongTries', () => {
	// The locked schedule: three wrong tries cost nothing, then 30 s, 1 min, 5 min, and 15 min for every try after.
	it.each([
		[0, 0],
		[1, 0],
		[2, 0],
		[3, 0],
		[4, 30_000],
		[5, 60_000],
		[6, 300_000],
		[7, 900_000],
		[20, 900_000]
	])('after %i wrong tries in a row the wait is %i ms', (count, waitMs) => {
		expect(waitAfterWrongTries(count)).toBe(waitMs);
	});
});

describe('readTries', () => {
	it('reads an absent row as no wrong tries', async () => {
		expect(await readTries(db)).toEqual({ count: 0, waitMs: 0, pending: false });
	});

	// The store is plain, so anything could be written into it; a bad row must not turn into a NaN wait.
	it('reads a row of the wrong shape as no wrong tries', async () => {
		await putTries({ count: 'x', waitMs: -5, pending: 'yes' });
		expect(await readTries(db)).toEqual({ count: 0, waitMs: 0, pending: false });
	});
});

describe('runPinCheck', () => {
	// A tab killed while the key was deriving must still have counted the try: the write lands before the check starts.
	it('writes the try, the next wait and pending BEFORE the check starts', async () => {
		await putTries({ count: 3, waitMs: 0, pending: false });
		const seen: TriesState[] = [];
		await runPinCheck(db, async () => {
			seen.push(await readTries(db));
			return { kind: 'wrong' };
		});
		expect(seen).toEqual([{ count: 4, waitMs: 30_000, pending: true }]);
	});

	it('reports a wrong try with the count and the wait it now owes, and clears pending', async () => {
		await putTries({ count: 3, waitMs: 0, pending: false });
		expect(await runPinCheck(db, wrong)).toEqual({
			kind: 'wrong',
			count: 4,
			waitMs: 30_000,
			unfinished: false
		});
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 30_000, pending: false });
	});

	// Two tabs checking at once must run one after the other: the second must not see the first's pending as a killed check.
	it('runs checks from two tabs one after the other and counts both', async () => {
		const otherTab = await openMtcDb(db.name);
		opened.push(otherTab);
		let running = 0;
		let overlap = 0;
		const slowWrong = async (): Promise<PinCheckResult<never>> => {
			running++;
			overlap = Math.max(overlap, running);
			await sleep(40);
			running--;
			return { kind: 'wrong' };
		};
		const outcomes = await Promise.all([
			runPinCheck(db, slowWrong),
			runPinCheck(otherTab, slowWrong)
		]);
		expect(overlap).toBe(1);
		expect(await readTries(db)).toEqual({ count: 2, waitMs: 0, pending: false });
		expect(outcomes.map((o) => (o.kind === 'wrong' ? [o.count, o.unfinished] : o))).toEqual([
			[1, false],
			[2, false]
		]);
	});

	it('answers "waiting" while a wait is owed, and never runs the check', async () => {
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		const check = vi.fn(wrong);
		expect(await runPinCheck(db, check)).toEqual({ kind: 'waiting', waitMs: 30_000 });
		expect(check).not.toHaveBeenCalled();
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 30_000, pending: false });
	});

	it('resets the row on a good check and reports the old count once', async () => {
		await putTries({ count: 2, waitMs: 0, pending: false });
		expect(await runPinCheck(db, async () => ({ kind: 'good', value: 'key' }))).toEqual({
			kind: 'good',
			value: 'key',
			wrongTries: 2,
			unfinished: false
		});
		expect(await readTries(db)).toEqual({ count: 0, waitMs: 0, pending: false });
		const again = await runPinCheck(db, async () => ({ kind: 'good', value: 'key' }));
		expect(again).toMatchObject({ kind: 'good', wrongTries: 0 });
	});

	// Low memory or a stored KDF tuple that does not match is not the person's mistake.
	it('puts the row back exactly when a check could not count', async () => {
		await putTries({ count: 3, waitMs: 0, pending: false });
		const inside: TriesState[] = [];
		const outcome = await runPinCheck(db, async () => {
			inside.push(await readTries(db));
			return { kind: 'not-counted' };
		});
		expect(outcome).toEqual({ kind: 'not-counted' });
		expect(inside).toEqual([{ count: 4, waitMs: 30_000, pending: true }]);
		expect(await readTries(db)).toEqual({ count: 3, waitMs: 0, pending: false });
	});

	// A check left pending by a killed tab is still owed to the person: undoing this check's try must not erase that.
	it('puts back a pending flag an earlier killed check left, so the next check reports it', async () => {
		await putTries({ count: 1, waitMs: 0, pending: true });
		await runPinCheck(db, async () => ({ kind: 'not-counted' }));
		expect(await readTries(db)).toEqual({ count: 1, waitMs: 0, pending: true });
		expect(await runPinCheck(db, async () => ({ kind: 'good', value: 1 }))).toMatchObject({
			kind: 'good',
			unfinished: true
		});
	});

	// An Erase that lands during the check clears the row; undoing the try must not bring the old count back.
	it('leaves the tries row cleared when an Erase happens during a check that could not count', async () => {
		await putTries({ count: 6, waitMs: 0, pending: false });
		const outcome = await runPinCheck(db, async () => {
			await wipeAllStores(db);
			return { kind: 'not-counted' };
		});
		expect(outcome).toEqual({ kind: 'not-counted' });
		expect(await readTries(db)).toEqual({ count: 0, waitMs: 0, pending: false });
	});

	// The OS killed the tab mid-derive: that try was already counted, and the next check says so.
	it('counts a check left pending and says it never finished', async () => {
		await putTries({ count: 1, waitMs: 0, pending: true });
		expect(await runPinCheck(db, wrong)).toEqual({
			kind: 'wrong',
			count: 2,
			waitMs: 0,
			unfinished: true
		});
		expect(await readTries(db)).toEqual({ count: 2, waitMs: 0, pending: false });
		expect(await runPinCheck(db, async () => ({ kind: 'good', value: 1 }))).toMatchObject({
			kind: 'good',
			wrongTries: 2,
			unfinished: false
		});
	});

	it('reports a left-pending check on a good PIN too', async () => {
		await putTries({ count: 1, waitMs: 0, pending: true });
		expect(await runPinCheck(db, async () => ({ kind: 'good', value: 1 }))).toEqual({
			kind: 'good',
			value: 1,
			wrongTries: 1,
			unfinished: true
		});
	});

	it('keeps the try and clears pending when the check throws, and rethrows', async () => {
		await expect(
			runPinCheck(db, async () => {
				throw new Error('E_CHECK_FAILED');
			})
		).rejects.toThrow('E_CHECK_FAILED');
		expect(await readTries(db)).toEqual({ count: 1, waitMs: 0, pending: false });
	});

	// A real failure inside the check must not be reported as the lock timing out.
	it('rethrows an AbortError from the check as it is', async () => {
		await expect(
			runPinCheck(db, async () => {
				throw new DOMException('x', 'AbortError');
			})
		).rejects.toMatchObject({ name: 'AbortError' });
	});

	// A tab stuck holding the lock must end in the static timeout error, with the check never run.
	it('throws LockAcquisitionTimeout when the tries lock stays held', async () => {
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(30));
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holding = new Promise<void>((resolve) => {
			void navigator.locks.request(TRIES_LOCK_NAME, { mode: 'exclusive' }, () => {
				resolve();
				return held;
			});
		});
		await holding;
		const check = vi.fn(wrong);
		await expect(runPinCheck(db, check)).rejects.toBeInstanceOf(LockAcquisitionTimeout);
		expect(check).not.toHaveBeenCalled();
		release();
	});
});

describe('createWaitClock', () => {
	let perf = 0;
	const perfNow = () => perf;
	const from: TriesState = { count: 4, waitMs: 30_000, pending: false };

	beforeEach(() => {
		perf = 0;
		// Only the interval and the date are faked: IndexedDB and the test's own sleeps stay real.
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
	});

	// The clock's write opens its transaction inside the timer callback, so a read made after it queues behind it.
	function elapse(ms: number): void {
		perf += ms;
		vi.advanceTimersByTime(ms);
	}

	it('writes the remainder every 5 s and counts down by performance.now', async () => {
		await putTries(from);
		const clock = createWaitClock(db, from, { perfNow });
		expect(clock.remainingMs()).toBe(30_000);
		elapse(4_000);
		expect(await readTries(db)).toEqual(from);
		elapse(1_000);
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 25_000, pending: false });
		elapse(5_000);
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 20_000, pending: false });
		expect(clock.remainingMs()).toBe(20_000);
		clock.stop();
	});

	// Only the wait this tab started from may be lowered: a newer wrong try, or another tab's lower remainder, stands.
	it('leaves a row whose count has moved on alone', async () => {
		await putTries({ count: 5, waitMs: 60_000, pending: false });
		const clock = createWaitClock(db, from, { perfNow });
		elapse(5_000);
		expect(await readTries(db)).toEqual({ count: 5, waitMs: 60_000, pending: false });
		clock.stop();
	});

	it('never raises a stored wait that is already lower', async () => {
		await putTries({ count: 4, waitMs: 10_000, pending: false });
		const clock = createWaitClock(db, from, { perfNow });
		elapse(5_000);
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 10_000, pending: false });
		clock.stop();
	});

	it('resumes from the stored remainder when a new clock starts after a reload', async () => {
		await putTries(from);
		const first = createWaitClock(db, from, { perfNow });
		elapse(10_000);
		first.stop();
		const stored = await readTries(db);
		expect(stored.waitMs).toBe(20_000);

		let perfAfterReload = 0;
		const second = createWaitClock(db, stored, { perfNow: () => perfAfterReload });
		perfAfterReload += 5_000;
		vi.advanceTimersByTime(5_000);
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 15_000, pending: false });
		expect(second.remainingMs()).toBe(15_000);
		second.stop();
	});

	// Moving the clock forward must not skip a wait.
	it('is not moved by the system clock jumping forward', async () => {
		await putTries(from);
		const clock = createWaitClock(db, from, { perfNow });
		vi.setSystemTime(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
		elapse(5_000);
		expect(clock.remainingMs()).toBe(25_000);
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 25_000, pending: false });
		clock.stop();
	});

	// A hidden tab's timers are throttled: one tick can arrive long after the wait ran out. The count comes from the
	// monotonic clock, not from how many ticks fired.
	it('counts by performance.now, not by timer ticks, when the timers run late', async () => {
		await putTries(from);
		const clock = createWaitClock(db, from, { perfNow });
		perf += 60_000;
		vi.advanceTimersByTime(5_000);
		expect(clock.remainingMs()).toBe(0);
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 0, pending: false });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('writes zero when the wait is over, then stops its timer', async () => {
		await putTries({ count: 4, waitMs: 10_000, pending: false });
		const clock = createWaitClock(db, { count: 4, waitMs: 10_000, pending: false }, { perfNow });
		elapse(5_000);
		elapse(5_000);
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 0, pending: false });
		expect(clock.remainingMs()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('starts no timer for a wait of zero, and none after stop', async () => {
		createWaitClock(db, { count: 3, waitMs: 0, pending: false }, { perfNow });
		expect(vi.getTimerCount()).toBe(0);
		await putTries(from);
		const clock = createWaitClock(db, from, { perfNow });
		expect(vi.getTimerCount()).toBe(1);
		clock.stop();
		expect(vi.getTimerCount()).toBe(0);
		elapse(5_000);
		expect(await readTries(db)).toEqual(from);
	});
});

// A reset brings the same count back, so a clock that only knew its count could lower a LATER wait at that count. The
// wait id is what tells two waits at one count apart.
describe('the wait id', () => {
	const UINT32 = 2 ** 32;
	let perf = 0;
	const perfNow = () => perf;
	const from: TriesState = { count: 4, waitMs: 30_000, pending: false };

	/** A row at count 4 with 30 s owed, written the way the app writes it: by a counted try. */
	async function countedToFour(): Promise<number> {
		await putTries({ count: 3, waitMs: 0, pending: false });
		await runPinCheck(db, wrong);
		const row = await readWaitId(db);
		expect(row.count).toBe(4);
		return row.waitId;
	}

	function elapse(ms: number): void {
		perf += ms;
		vi.advanceTimersByTime(ms);
	}

	beforeEach(() => {
		perf = 0;
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
	});

	it('is a new random 32-bit number on every counted try', async () => {
		await runPinCheck(db, wrong);
		const first = await readWaitId(db);
		await runPinCheck(db, wrong);
		const second = await readWaitId(db);

		expect([first.count, second.count]).toEqual([1, 2]);
		for (const { waitId } of [first, second]) {
			expect(Number.isInteger(waitId)).toBe(true);
			expect(waitId).toBeGreaterThanOrEqual(0);
			expect(waitId).toBeLessThan(UINT32);
		}
		expect(second.waitId).not.toBe(first.waitId);
	});

	it('is kept by the write that ends a check and by the clock', async () => {
		await putTries({ count: 3, waitMs: 0, pending: false });
		let during = -1;
		await runPinCheck(db, async () => {
			during = (await readWaitId(db)).waitId;
			return { kind: 'wrong' };
		});
		expect(during).toBeGreaterThanOrEqual(0);
		expect(await readWaitId(db)).toEqual({ count: 4, waitId: during });

		const clock = createWaitClock(db, from, { perfNow, waitId: () => during });
		elapse(5_000);
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 25_000, pending: false });
		expect(await readWaitId(db)).toEqual({ count: 4, waitId: during });
		clock.stop();
	});

	it('lets a clock for another wait at the same count write nothing', async () => {
		const id = await countedToFour();
		const clock = createWaitClock(db, from, { perfNow, waitId: () => (id + 1) % UINT32 });
		elapse(5_000);

		expect(await readTries(db)).toEqual({ count: 4, waitMs: 30_000, pending: false });
		clock.stop();
	});

	// The store is plain: an older build's row has no id, and a script could leave anything.
	it.each([
		['no id', {}],
		['a text id', { waitId: 'x' }],
		['a negative id', { waitId: -1 }],
		['a fractional id', { waitId: 1.5 }],
		['an id past 32 bits', { waitId: UINT32 }],
		['a NaN id', { waitId: Number.NaN }]
	])('reads a row with %s as id 0, and a clock for id 0 may lower it', async (_name, extra) => {
		await putTries({ ...from, ...extra });
		expect(await readWaitId(db)).toEqual({ count: 4, waitId: 0 });

		const clock = createWaitClock(db, from, { perfNow, waitId: () => 0 });
		elapse(5_000);
		expect(await readTries(db)).toEqual({ count: 4, waitMs: 25_000, pending: false });
		clock.stop();
	});

	it('goes back with an undone try and goes away with a reset row', async () => {
		await putTries({ count: 3, waitMs: 0, pending: false, waitId: 5 });
		await runPinCheck(db, async () => ({ kind: 'not-counted' }));
		expect(await readWaitId(db)).toEqual({ count: 3, waitId: 5 });

		await runPinCheck(db, async () => ({ kind: 'good', value: 1 }));
		const [row] = await rawRows();
		expect(Object.keys(row ?? {}).sort()).toEqual(['count', 'id', 'pending', 'waitMs']);
		expect(await readWaitId(db)).toEqual({ count: 0, waitId: 0 });
	});
});

describe('the lock counter', () => {
	it('reads an absent counter as 0 and changes it on every bump', async () => {
		expect(await readCounter(db)).toBe(0);
		const first = await bumpCounter(db);
		expect(first).not.toBe(0);
		expect(await readCounter(db)).toBe(first);
		const second = await bumpCounter(db);
		expect(second).not.toBe(first);
		expect(await readCounter(db)).toBe(second);
	});

	// A PIN change or restore bumps inside its own transaction: if that transaction aborts, no tab may be told a Lock happened.
	it('changes with its caller transaction, and rolls back with it', async () => {
		const before = await readCounter(db);
		await expect(
			withStores(db, ['app-lock', 'keystore'], 'readwrite', async (tx) => {
				await bumpCounterIn(tx);
				throw new Error('E_ABORT_ME');
			})
		).rejects.toThrow('E_ABORT_ME');
		expect(await readCounter(db)).toBe(before);

		const bumped = await withStores(db, ['app-lock', 'keystore'], 'readwrite', (tx) => {
			tx.objectStore('keystore').put({ id: 0, marker: 'same-transaction' });
			return bumpCounterIn(tx);
		});
		expect(bumped).not.toBe(before);
		expect(await readCounter(db)).toBe(bumped);
	});

	it('clears the wrong tries in a caller transaction and keeps the counter', async () => {
		await putTries({ count: 5, waitMs: 60_000, pending: true });
		const counter = await bumpCounter(db);
		await withStores(db, 'app-lock', 'readwrite', (tx) => {
			clearTriesIn(tx);
		});
		expect(await readTries(db)).toEqual({ count: 0, waitMs: 0, pending: false });
		expect(await readCounter(db)).toBe(counter);
	});
});

describe('what the rows hold', () => {
	// Nothing derived from the PIN, its length or a time stamp may ever sit in this plain store.
	it('is only the two listed rows with only the listed keys after every path', async () => {
		const shape = async () => {
			const rows = await rawRows();
			return rows.map((row) => `${String(row.id)}:${Object.keys(row).sort().join(',')}`).sort();
		};
		const triesKeys = 'tries:count,id,pending,waitMs';
		// A counted try also holds the random id of its wait, and nothing else is added.
		const countedKeys = 'tries:count,id,pending,waitId,waitMs';
		const counterKeys = 'counter:id,value';

		await runPinCheck(db, wrong);
		expect(await shape()).toEqual([countedKeys]);
		await runPinCheck(db, async () => ({ kind: 'good', value: 1 }));
		expect(await shape()).toEqual([triesKeys]);
		await runPinCheck(db, async () => ({ kind: 'not-counted' }));
		await runPinCheck(db, async () => {
			throw new Error('E_CHECK_FAILED');
		}).catch(() => undefined);
		expect(await shape()).toEqual([countedKeys]);

		await bumpCounter(db);
		await withStores(db, 'app-lock', 'readwrite', (tx) => {
			clearTriesIn(tx);
			return bumpCounterIn(tx);
		});
		expect(await shape()).toEqual([counterKeys]);

		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
		await putTries({ count: 4, waitMs: 30_000, pending: false });
		let perf = 0;
		createWaitClock(db, { count: 4, waitMs: 30_000, pending: false }, { perfNow: () => perf });
		perf = 5_000;
		vi.advanceTimersByTime(5_000);
		expect(await shape()).toEqual([counterKeys, triesKeys]);
		expect((await readTries(db)).waitMs).toBe(25_000);
		for (const row of await rawRows()) {
			for (const [key, value] of Object.entries(row)) {
				expect(['string', 'number', 'boolean'], key).toContain(typeof value);
			}
		}
	});
});
