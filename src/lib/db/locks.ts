/**
 * Hierarchical lock ordering for all profile writes (Web Locks API).
 *
 * - `mtc-keystore` SHARED: normal writes hold it shared (concurrent with each
 *   other) but serialize against an EXCLUSIVE keystore holder.
 * - `profile-write` EXCLUSIVE: serializes profile writes against each other.
 * - `rotateOrUpgrade` takes `mtc-keystore` EXCLUSIVE, excluding all normal
 *   writes. Two users: the v1.1 key-rotation / passphrase-upgrade seam, and the
 *   device erase (an unlocked erase clears while a save is mid-encrypt, and that
 *   save's write then lands after it - resurrecting a row into a wiped store).
 *
 * Every acquisition is bounded by `AbortSignal.timeout` (no
 * silent lock drops). A timed-out acquisition surfaces as `LockAcquisitionTimeout`,
 * never a hang and never a silent skip.
 *
 * A caller may also pass a run signal: aborting it withdraws a request still
 * queued and throws `RunAbortedError`. Web Locks ignore an abort once a lock is
 * granted (the callback runs on), so a caller that must not write after an
 * abort checks its signal inside the callback.
 */
export const LOCK_TIMEOUT_MS = 10_000;

export class LockAcquisitionTimeout extends Error {
	constructor() {
		super('E_LOCK_TIMEOUT');
		this.name = 'LockAcquisitionTimeout';
	}
}

export class RunAbortedError extends Error {
	constructor() {
		super('E_RUN_ABORTED');
		this.name = 'RunAbortedError';
	}
}

/**
 * `AbortSignal.timeout()` aborts with a `TimeoutError` DOMException; a manual
 * `AbortController.abort()` produces an `AbortError`. Map both to the typed
 * lock-timeout so neither leaks as a raw DOMException.
 */
function isAbortOrTimeout(err: unknown): boolean {
	return err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * One signal that aborts when any input does (undefined entries are skipped).
 * `AbortSignal.any` is used where the browser has it; otherwise a controller
 * follows the inputs and takes the first reason, aborting at once if an input
 * is already aborted.
 */
function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
	const present = signals.filter((s): s is AbortSignal => s !== undefined);
	if (typeof AbortSignal.any === 'function') return AbortSignal.any(present);
	const ctl = new AbortController();
	for (const s of present) {
		if (s.aborted) {
			ctl.abort(s.reason);
			return ctl.signal;
		}
	}
	for (const s of present) {
		s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
	}
	return ctl.signal;
}

function mapLockError(err: unknown, runSignal: AbortSignal | undefined): unknown {
	if (runSignal?.aborted) return new RunAbortedError();
	if (isAbortOrTimeout(err)) return new LockAcquisitionTimeout();
	return err;
}

export async function withWriteLocks<T>(
	loadKeystoreGeneration: () => Promise<number>,
	fn: (keystoreGeneration: number) => Promise<T>,
	timeoutMs = LOCK_TIMEOUT_MS,
	signal?: AbortSignal
): Promise<T> {
	try {
		return await navigator.locks.request(
			'mtc-keystore',
			{ mode: 'shared', signal: anySignal([AbortSignal.timeout(timeoutMs), signal]) },
			async () =>
				navigator.locks.request(
					'profile-write',
					{ mode: 'exclusive', signal: anySignal([AbortSignal.timeout(timeoutMs), signal]) },
					async () => {
						const gen = await loadKeystoreGeneration();
						return fn(gen);
					}
				)
		);
	} catch (err) {
		throw mapLockError(err, signal);
	}
}

export async function rotateOrUpgrade<T>(
	fn: () => Promise<T>,
	timeoutMs = LOCK_TIMEOUT_MS,
	signal?: AbortSignal
): Promise<T> {
	try {
		return await navigator.locks.request(
			'mtc-keystore',
			{ mode: 'exclusive', signal: anySignal([AbortSignal.timeout(timeoutMs), signal]) },
			fn
		);
	} catch (err) {
		throw mapLockError(err, signal);
	}
}
