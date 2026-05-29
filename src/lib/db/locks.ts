/**
 * Hierarchical lock ordering for all profile writes (Web Locks API).
 *
 * - `mtc-keystore` SHARED: normal writes hold it shared (concurrent with each
 *   other) but serialize against an EXCLUSIVE keystore holder.
 * - `profile-write` EXCLUSIVE: serializes profile writes against each other.
 * - `rotateOrUpgrade` takes `mtc-keystore` EXCLUSIVE, excluding all normal
 *   writes (the v1.1 key-rotation / passphrase-upgrade seam; harmless in v1.0).
 *
 * Every acquisition is bounded by `AbortSignal.timeout` (spec invariant 6: no
 * silent lock drops). A timed-out acquisition surfaces as `LockAcquisitionTimeout`,
 * never a hang and never a silent skip.
 *
 * Source: Phase 2 spec section 7 "Hierarchical lock ordering" + section 4
 * (invariants 5, 6).
 */
export const LOCK_TIMEOUT_MS = 10_000;

export class LockAcquisitionTimeout extends Error {
	constructor() {
		super('E_LOCK_TIMEOUT');
		this.name = 'LockAcquisitionTimeout';
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

export async function withWriteLocks<T>(
	loadKeystoreGeneration: () => Promise<number>,
	fn: (keystoreGeneration: number) => Promise<T>,
	timeoutMs = LOCK_TIMEOUT_MS
): Promise<T> {
	try {
		return await navigator.locks.request(
			'mtc-keystore',
			{ mode: 'shared', signal: AbortSignal.timeout(timeoutMs) },
			async () =>
				navigator.locks.request(
					'profile-write',
					{ mode: 'exclusive', signal: AbortSignal.timeout(timeoutMs) },
					async () => {
						const gen = await loadKeystoreGeneration();
						return fn(gen);
					}
				)
		);
	} catch (err) {
		if (isAbortOrTimeout(err)) throw new LockAcquisitionTimeout();
		throw err;
	}
}

export async function rotateOrUpgrade<T>(
	fn: () => Promise<T>,
	timeoutMs = LOCK_TIMEOUT_MS
): Promise<T> {
	try {
		return await navigator.locks.request(
			'mtc-keystore',
			{ mode: 'exclusive', signal: AbortSignal.timeout(timeoutMs) },
			fn
		);
	} catch (err) {
		if (isAbortOrTimeout(err)) throw new LockAcquisitionTimeout();
		throw err;
	}
}
