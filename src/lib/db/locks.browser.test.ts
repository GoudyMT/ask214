import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	withWriteLocks,
	rotateOrUpgrade,
	LockAcquisitionTimeout,
	RunAbortedError,
	LOCK_TIMEOUT_MS
} from './locks';

describe('withWriteLocks', () => {
	it('invokes the callback once with the value from the loader fn', async () => {
		const calls: number[] = [];
		const result = await withWriteLocks(
			async () => 42,
			async (gen) => {
				calls.push(gen);
				return 'done';
			}
		);
		expect(calls).toEqual([42]);
		expect(result).toBe('done');
	});

	it('serializes concurrent calls (no critical-section interleaving)', async () => {
		const trace: string[] = [];
		const work = (label: string) =>
			withWriteLocks(
				async () => 0,
				async () => {
					trace.push(`start:${label}`);
					await new Promise((r) => setTimeout(r, 5));
					trace.push(`end:${label}`);
				}
			);
		await Promise.all([work('a'), work('b'), work('c')]);
		for (const label of ['a', 'b', 'c']) {
			const startIdx = trace.indexOf(`start:${label}`);
			const endIdx = trace.indexOf(`end:${label}`);
			expect(endIdx).toBe(startIdx + 1);
		}
	});

	it('throws LockAcquisitionTimeout if locks unavailable within the timeout', async () => {
		let release: () => void = () => {};
		const holding = navigator.locks.request('profile-write', { mode: 'exclusive' }, async () => {
			await new Promise<void>((r) => {
				release = r;
			});
		});
		try {
			await expect(
				withWriteLocks(
					async () => 0,
					async () => 'never',
					50
				)
			).rejects.toThrow(LockAcquisitionTimeout);
		} finally {
			release();
			await holding;
		}
	});

	it('exposes LOCK_TIMEOUT_MS = 10_000 by default (per spec invariant 6)', () => {
		expect(LOCK_TIMEOUT_MS).toBe(10_000);
	});
});

describe('rotateOrUpgrade', () => {
	it('acquires mtc-keystore exclusively and runs the callback', async () => {
		const result = await rotateOrUpgrade(async () => 'rotated');
		expect(result).toBe('rotated');
	});

	it('a timeout without a run signal still throws LockAcquisitionTimeout', async () => {
		const peer = await hold('mtc-keystore', 'exclusive');
		try {
			await expect(rotateOrUpgrade(async () => 'never', 50)).rejects.toThrow(
				LockAcquisitionTimeout
			);
		} finally {
			await peer.release();
		}
	});
});

/**
 * A peer holding a lock: `hold(...)` resolves once the peer holds the lock,
 * and `release` frees it and waits for the lock to be gone.
 */
async function hold(name: string, mode: LockMode): Promise<{ release: () => Promise<void> }> {
	let release: () => void = () => {};
	let holding: Promise<void> = Promise.resolve();
	const granted = new Promise<void>((resolve) => {
		holding = navigator.locks.request(name, { mode }, async () => {
			await new Promise<void>((r) => {
				release = r;
				resolve();
			});
		});
	});
	await granted;
	return {
		release: async () => {
			release();
			await holding;
		}
	};
}

/** What a promise did, without hanging the test when it does nothing. */
async function outcomeOf(p: Promise<unknown>): Promise<unknown> {
	const settled = p.then(
		() => 'resolved' as const,
		(err: unknown) => err
	);
	const pending = new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 300));
	return Promise.race([settled, pending]);
}

const nextTurn = () => new Promise<void>((r) => setTimeout(r, 20));

describe('a run signal', () => {
	it('an aborted run signal withdraws a queued exclusive request', async () => {
		const peer = await hold('mtc-keystore', 'shared');
		const fn = vi.fn(async () => 'ran');
		const ctl = new AbortController();
		try {
			const run = rotateOrUpgrade(fn, LOCK_TIMEOUT_MS, ctl.signal);
			ctl.abort();
			expect(await outcomeOf(run)).toBeInstanceOf(RunAbortedError);
		} finally {
			await peer.release();
		}
		await nextTurn();
		expect(fn).not.toHaveBeenCalled();
	});

	describe('withWriteLocks passes the run signal to both nested requests', () => {
		it('the outer shared request', async () => {
			const peer = await hold('mtc-keystore', 'exclusive');
			const load = vi.fn(async () => 0);
			const fn = vi.fn(async () => 'ran');
			const ctl = new AbortController();
			try {
				const run = withWriteLocks(load, fn, LOCK_TIMEOUT_MS, ctl.signal);
				ctl.abort();
				expect(await outcomeOf(run)).toBeInstanceOf(RunAbortedError);
			} finally {
				await peer.release();
			}
			await nextTurn();
			expect(load).not.toHaveBeenCalled();
			expect(fn).not.toHaveBeenCalled();
		});

		it('the inner exclusive request', async () => {
			const peer = await hold('profile-write', 'exclusive');
			const fn = vi.fn(async () => 'ran');
			const ctl = new AbortController();
			try {
				const run = withWriteLocks(async () => 0, fn, LOCK_TIMEOUT_MS, ctl.signal);
				// The outer shared request is granted at once; give the inner one time to queue.
				await nextTurn();
				ctl.abort();
				expect(await outcomeOf(run)).toBeInstanceOf(RunAbortedError);
			} finally {
				await peer.release();
			}
			await nextTurn();
			expect(fn).not.toHaveBeenCalled();
		});
	});

	it('a callback error after the run was aborted reports as RunAbortedError', async () => {
		const ctl = new AbortController();
		let started: () => void = () => {};
		const hasStarted = new Promise<void>((r) => {
			started = r;
		});
		let proceed: () => void = () => {};
		const mayThrow = new Promise<void>((r) => {
			proceed = r;
		});
		const run = rotateOrUpgrade(
			async () => {
				started();
				await mayThrow;
				throw new Error('E_PROBE');
			},
			LOCK_TIMEOUT_MS,
			ctl.signal
		);
		await hasStarted;
		ctl.abort();
		proceed();
		expect(await outcomeOf(run)).toBeInstanceOf(RunAbortedError);
	});

	it('an already-aborted run signal rejects without running', async () => {
		const fn = vi.fn(async () => 'ran');
		const ctl = new AbortController();
		ctl.abort();
		expect(await outcomeOf(rotateOrUpgrade(fn, LOCK_TIMEOUT_MS, ctl.signal))).toBeInstanceOf(
			RunAbortedError
		);
		expect(
			await outcomeOf(withWriteLocks(async () => 0, fn, LOCK_TIMEOUT_MS, ctl.signal))
		).toBeInstanceOf(RunAbortedError);
		await nextTurn();
		expect(fn).not.toHaveBeenCalled();
	});

	describe('the fallback combines signals when AbortSignal.any is missing', () => {
		const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any');

		beforeEach(() => {
			Object.defineProperty(AbortSignal, 'any', {
				value: undefined,
				configurable: true,
				writable: true
			});
		});

		afterEach(() => {
			if (original) Object.defineProperty(AbortSignal, 'any', original);
			else delete (AbortSignal as { any?: unknown }).any;
		});

		it('the fallback combines signals: a run signal still withdraws a queued request', async () => {
			expect((AbortSignal as { any?: unknown }).any).toBeUndefined();
			const peer = await hold('mtc-keystore', 'shared');
			const fn = vi.fn(async () => 'ran');
			const ctl = new AbortController();
			try {
				const run = rotateOrUpgrade(fn, LOCK_TIMEOUT_MS, ctl.signal);
				ctl.abort();
				expect(await outcomeOf(run)).toBeInstanceOf(RunAbortedError);
			} finally {
				await peer.release();
			}
			await nextTurn();
			expect(fn).not.toHaveBeenCalled();
		});

		it('the fallback keeps the timeout: a short timeout still throws LockAcquisitionTimeout', async () => {
			const peer = await hold('mtc-keystore', 'exclusive');
			const ctl = new AbortController();
			try {
				expect(
					await outcomeOf(rotateOrUpgrade(async () => 'never', 50, ctl.signal))
				).toBeInstanceOf(LockAcquisitionTimeout);
			} finally {
				await peer.release();
			}
		});

		it('the fallback rejects an already-aborted run signal without running', async () => {
			const fn = vi.fn(async () => 'ran');
			const ctl = new AbortController();
			ctl.abort();
			expect(await outcomeOf(rotateOrUpgrade(fn, LOCK_TIMEOUT_MS, ctl.signal))).toBeInstanceOf(
				RunAbortedError
			);
			await nextTurn();
			expect(fn).not.toHaveBeenCalled();
		});
	});
});
