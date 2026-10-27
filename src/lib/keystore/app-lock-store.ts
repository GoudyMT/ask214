import { LOCK_TIMEOUT_MS, LockAcquisitionTimeout } from '../db/locks';
import { reqToPromise, withStores } from '../db/schema';
import { safeLog } from '../log/safelog';

/**
 * The app lock's plain store: two rows, the wrong-try row and a durable lock counter. It sits outside the encrypted
 * stores on purpose - the wrong tries must be readable before anything unlocks - so it holds nothing derived from the
 * PIN, nothing about its length and no time stamp: a count, a wait in milliseconds, a pending flag and a random id for
 * the wait (new with every counted try, so a countdown can tell one wait from a later one at the same count), and
 * the lock counter.
 */
export const TRIES_LOCK_NAME = 'mtc-app-lock-tries';

const TRIES_ROW = 'tries';
const COUNTER_ROW = 'counter';
// Three wrong tries in a row cost nothing; then each further try owes a longer wait, up to a cap.
const FREE_WRONG_TRIES = 3;
const WAITS_AFTER_FREE_MS = [30_000, 60_000, 300_000] as const;
const WAIT_CAP_MS = 900_000;
const WAIT_WRITE_EVERY_MS = 5_000;

export type TriesState = Readonly<{ count: number; waitMs: number; pending: boolean }>;
export type PinCheckResult<T> =
	{ kind: 'good'; value: T } | { kind: 'wrong' } | { kind: 'not-counted' };
export type PinCheckOutcome<T> =
	| { kind: 'waiting'; waitMs: number }
	| { kind: 'good'; value: T; wrongTries: number; unfinished: boolean }
	| { kind: 'wrong'; count: number; waitMs: number; unfinished: boolean }
	| { kind: 'not-counted' };

// The stored row: the three fields everyone sees, and the id of the wait. A row with no valid id reads as id 0, and an
// id of 0 is never written, so an older build's row and a cleared one look alike.
type TriesRow = TriesState & Readonly<{ waitId: number }>;

const NO_TRIES: TriesRow = { count: 0, waitMs: 0, pending: false, waitId: 0 };

/** The wait owed after the n-th wrong try in a row. */
export function waitAfterWrongTries(count: number): number {
	if (count <= FREE_WRONG_TRIES) return 0;
	return WAITS_AFTER_FREE_MS[count - FREE_WRONG_TRIES - 1] ?? WAIT_CAP_MS;
}

// The store is plain, so a row may be anything a script or an older build left; whatever is not a plain count reads as 0.
function nonNegative(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asRow(row: unknown): TriesRow {
	if (typeof row !== 'object' || row === null) return NO_TRIES;
	const r = row as Record<string, unknown>;
	const id = nonNegative(r.waitId);
	return {
		count: nonNegative(r.count),
		waitMs: nonNegative(r.waitMs),
		pending: r.pending === true,
		// Only a whole number below 2^32 survives the unsigned shift unchanged.
		waitId: id >>> 0 === id ? id : 0
	};
}

function getTries(tx: IDBTransaction): Promise<TriesRow> {
	return reqToPromise<unknown>(tx.objectStore('app-lock').get(TRIES_ROW)).then(asRow);
}

// Fresh object, never a spread of what was read: a stray key in a stored row does not survive the next write.
function putTries(tx: IDBTransaction, tries: TriesRow): void {
	tx.objectStore('app-lock').put({
		id: TRIES_ROW,
		count: tries.count,
		waitMs: tries.waitMs,
		pending: tries.pending,
		...(tries.waitId ? { waitId: tries.waitId } : {})
	});
}

export function readTries(db: IDBDatabase): Promise<TriesState> {
	return withStores(db, 'app-lock', 'readonly', getTries).then(({ count, waitMs, pending }) => ({
		count,
		waitMs,
		pending
	}));
}

/**
 * The stored row with the id of its wait, for a countdown to remember which wait it counts. Kept apart from `readTries`
 * so that the state callers pass around stays three fields.
 */
export function readTriesWithId(db: IDBDatabase): Promise<TriesState & { waitId: number }> {
	return withStores(db, 'app-lock', 'readonly', getTries);
}

/** Reads the row, changes it and writes it back in one transaction; resolves what was written. */
function changeTries(db: IDBDatabase, next: (row: TriesRow) => TriesRow): Promise<TriesRow> {
	return withStores(db, 'app-lock', 'readwrite', async (tx) => {
		const written = next(await getTries(tx));
		putTries(tx, written);
		return written;
	});
}

async function withTriesLock<T>(fn: () => Promise<T>): Promise<T> {
	let granted = false;
	try {
		return await navigator.locks.request(
			TRIES_LOCK_NAME,
			{ mode: 'exclusive', signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
			() => {
				granted = true;
				return fn();
			}
		);
	} catch (err) {
		// Only the wait for the lock maps to the timeout: an abort raised inside the check is a different failure.
		if (!granted && err instanceof DOMException) {
			if (err.name === 'TimeoutError' || err.name === 'AbortError')
				throw new LockAcquisitionTimeout();
		}
		throw err;
	}
}

type Start = { kind: 'waiting'; waitMs: number } | { kind: 'go'; before: TriesRow };

/**
 * Runs ONE PIN check (unlock, change, remove or the backup step-up) under the tries web lock, held for the whole
 * check, so checks in two tabs run one after the other and a `pending` found at the start can only be a check that
 * never finished (the OS killed the tab mid-derive). The try is written before `check` starts, so a killed tab has
 * still counted it.
 */
export function runPinCheck<T>(
	db: IDBDatabase,
	check: () => Promise<PinCheckResult<T>>
): Promise<PinCheckOutcome<T>> {
	return withTriesLock(async (): Promise<PinCheckOutcome<T>> => {
		const start = await withStores<Start>(db, 'app-lock', 'readwrite', async (tx) => {
			const before = await getTries(tx);
			if (before.waitMs > 0) return { kind: 'waiting', waitMs: before.waitMs };
			const count = before.count + 1;
			putTries(tx, {
				count,
				waitMs: waitAfterWrongTries(count),
				pending: true,
				// Random and unrelated to the PIN or to time: it only has to differ from the id of the wait before it.
				waitId: crypto.getRandomValues(new Uint32Array(1))[0] as number
			});
			return { kind: 'go', before };
		});
		if (start.kind === 'waiting') return start;
		const { before } = start;

		let result: PinCheckResult<T>;
		try {
			result = await check();
		} catch (err) {
			// The try stands. A failed clean-up leaves pending set, which the next check reports as unfinished.
			await changeTries(db, (row) => ({ ...row, pending: false })).catch(() =>
				safeLog({ code: 'E_INTERNAL' })
			);
			throw err;
		}

		if (result.kind === 'good') {
			await changeTries(db, () => NO_TRIES);
			return {
				kind: 'good',
				value: result.value,
				wrongTries: before.count,
				unfinished: before.pending
			};
		}
		if (result.kind === 'wrong') {
			const row = await changeTries(db, (stored) => ({ ...stored, pending: false }));
			return { kind: 'wrong', count: row.count, waitMs: row.waitMs, unfinished: before.pending };
		}
		// Undo only this check's own write. A row an Erase (or another clear of the row) emptied meanwhile is not this
		// check's to put back.
		await changeTries(db, (stored) =>
			stored.count === before.count + 1 && stored.pending ? before : { ...stored, pending: false }
		);
		return { kind: 'not-counted' };
	});
}

export async function readCounterIn(tx: IDBTransaction): Promise<number> {
	const row = await reqToPromise<unknown>(tx.objectStore('app-lock').get(COUNTER_ROW));
	return nonNegative((row as { value?: unknown } | undefined)?.value);
}

export function writeCounterIn(tx: IDBTransaction, value: number): void {
	tx.objectStore('app-lock').put({ id: COUNTER_ROW, value });
}

export function readCounter(db: IDBDatabase): Promise<number> {
	return withStores(db, 'app-lock', 'readonly', readCounterIn);
}

/** For a caller's own readwrite transaction that includes 'app-lock' (turn-on, a PIN change, the restore). */
export async function bumpCounterIn(tx: IDBTransaction): Promise<number> {
	const next = (await readCounterIn(tx)) + 1;
	writeCounterIn(tx, next);
	return next;
}

/** Changes the counter (value + 1) in its own transaction; resolves the new value. */
export function bumpCounter(db: IDBDatabase): Promise<number> {
	return withStores(db, 'app-lock', 'readwrite', bumpCounterIn);
}

/** For a caller's own readwrite transaction that includes 'app-lock'. */
export function clearTriesIn(tx: IDBTransaction): void {
	tx.objectStore('app-lock').delete(TRIES_ROW);
}

/**
 * Counts an owed wait down by performance.now (never Date.now, so moving the clock skips nothing) in a live tab, and
 * every 5 s writes the remainder by compare-and-set inside one readwrite transaction: only while the row's count is
 * still the count the clock started from AND its wait id is the id of the wait being counted, and only ever LOWERING
 * waitMs, never raising it and never touching count. The same count comes back after every reset, so the count alone
 * cannot tell this wait from a later one. `deps.waitId` gives that id when asked (a row with no id is id 0, the
 * default). At zero it writes waitMs 0 (same rule) and stops. A reload starts a new clock from the stored remainder.
 */
export function createWaitClock(
	db: IDBDatabase,
	from: TriesState,
	deps: {
		perfNow?: () => number;
		setInterval?: typeof setInterval;
		clearInterval?: typeof clearInterval;
		waitId?: () => number;
	} = {}
): { remainingMs(): number; stop(): void; writeNow(): void } {
	const now = deps.perfNow ?? (() => performance.now());
	const startedAt = now();
	const remainingMs = () => Math.max(0, from.waitMs - (now() - startedAt));

	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		(deps.clearInterval ?? clearInterval)(timer);
		timer = undefined;
	};
	const write = () => {
		// Rounded up: the stored wait is never shorter than what is owed.
		const left = Math.ceil(remainingMs());
		if (left === 0) stop();
		// The transaction opens inside this call, before anything is awaited.
		withStores(db, 'app-lock', 'readwrite', async (tx) => {
			const row = await getTries(tx);
			// Asked inside the transaction: a countdown learns its id from a read that finished before this one began.
			const same = row.count === from.count && row.waitId === (deps.waitId?.() ?? 0);
			if (same && left < row.waitMs) putTries(tx, { ...row, waitMs: left });
		}).catch(() => safeLog({ code: 'E_INTERNAL' }));
	};
	if (from.waitMs > 0) timer = (deps.setInterval ?? setInterval)(write, WAIT_WRITE_EVERY_MS);
	// For a caller that needs the stored wait right now (a page that just came back), not at the next 5 s tick.
	return { remainingMs, stop, writeNow: write };
}
