import { describe, it, expect } from 'vitest';
import { withWriteLocks, rotateOrUpgrade, LockAcquisitionTimeout, LOCK_TIMEOUT_MS } from './locks';

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
});
