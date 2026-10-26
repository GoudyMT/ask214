import {
	readTries,
	runPinCheck,
	type createWaitClock,
	type PinCheckResult
} from '../keystore/app-lock-store';
import {
	KeystoreHmacMismatchError,
	openPinSession,
	WrongPinError,
	type KeySession
} from '../keystore/session';
import { readPinRowAndCounter } from '../keystore/unlock-row';
import type { derivePinKeys } from '../keystore/pin-derive';
import type { loadAppLock } from './load-app-lock';
import { CHECK_LOW_MEMORY_LINE, NOT_RIGHT_LINE, waitLine } from './pin-lines';
import { createCountdown } from './wait-countdown';

export type CurrentPinResult = { ok: true; session: KeySession } | { ok: false; line: string };

type CurrentPinDeps = {
	derive?: typeof derivePinKeys | undefined;
	clock?: Parameters<typeof createWaitClock>[2] | undefined;
	/** The PIN code's page side, from the one lazy entry the settings rows share; this module imports none of it itself. */
	loadDerive: () => Promise<Awaited<ReturnType<typeof loadAppLock>>[0]>;
	/** Each new line of the wait this check starts to count down, and null when it is over (see `followWait`). */
	onWaitLine?: ((line: string | null) => void) | undefined;
};

/**
 * The check of the current PIN that Change, Remove and the step-up before a backup all make, as an unlock does: the try is
 * counted before the derive. The keys a good PIN opens are returned and never held by the tab. One checker per row, so
 * the wait it starts to count down is the row's own; `stop` ends that count when the row goes.
 */
export function createCurrentPinCheck(deps: CurrentPinDeps): {
	check(db: IDBDatabase, typed: string, failedLine: string): Promise<CurrentPinResult>;
	stop(): void;
} {
	let counter: ReturnType<typeof createCountdown> | null = null;

	// The line for an owed wait: a new wait starts its own count, and a press that only finds the wait still owed leaves
	// the running count alone, so pressing never pushes the end away. The caller hears the line returned as its own, so the
	// count's later lines replace exactly that message.
	async function waitText(db: IDBDatabase, waitMs: number, fresh: boolean): Promise<string> {
		counter ??= createCountdown(db, { clock: deps.clock }, (line) => deps.onWaitLine?.(line));
		const left = fresh ? 0 : counter.remainingMs();
		const line = waitLine(left > 0 ? Math.ceil(left) : waitMs);
		if (left <= 0) counter.start(await readTries(db));
		deps.onWaitLine?.(line);
		return line;
	}

	async function check(
		db: IDBDatabase,
		typed: string,
		failedLine: string
	): Promise<CurrentPinResult> {
		const pinDerive = await deps.loadDerive();
		if (!pinDerive.isPinFormat(typed)) return { ok: false, line: NOT_RIGHT_LINE };
		const found = { lowMemory: false };
		const outcome = await runPinCheck(db, async (): Promise<PinCheckResult<KeySession>> => {
			const { row, counter } = await readPinRowAndCounter(db);
			if (row?.mode !== 'pin') return { kind: 'not-counted' };
			try {
				const keys = await (deps.derive ?? pinDerive.derivePinKeys)(typed, {
					kdf: row.kdf,
					salt: row.salt
				});
				return { kind: 'good', value: await openPinSession(row, keys, counter) };
			} catch (err) {
				if (err instanceof WrongPinError) return { kind: 'wrong' };
				if (err instanceof pinDerive.PinNoMemoryError) {
					found.lowMemory = true;
					return { kind: 'not-counted' };
				}
				if (err instanceof KeystoreHmacMismatchError) return { kind: 'not-counted' };
				throw err;
			}
		});
		if (outcome.kind === 'good') return { ok: true, session: outcome.value };
		if (outcome.kind === 'waiting')
			return { ok: false, line: await waitText(db, outcome.waitMs, false) };
		if (outcome.kind === 'wrong') {
			if (outcome.waitMs > 0) return { ok: false, line: await waitText(db, outcome.waitMs, true) };
			return { ok: false, line: NOT_RIGHT_LINE };
		}
		return { ok: false, line: found.lowMemory ? CHECK_LOW_MEMORY_LINE : failedLine };
	}

	return { check, stop: () => counter?.stop() };
}
