import { describe, it, expect, vi } from 'vitest';
import { eraseEverything, type EraseDeps } from './erase';

function makeDeps(over: Partial<EraseDeps> = {}): EraseDeps & { order: string[] } {
	const order: string[] = [];
	return {
		order,
		relock: vi.fn(() => void order.push('relock')),
		wipeAll: vi.fn(async () => void order.push('wipeAll')),
		clearStorage: vi.fn(() => void order.push('clearStorage')),
		clearCaches: vi.fn(async () => void order.push('clearCaches')),
		reload: vi.fn(() => void order.push('reload')),
		...over
	};
}

describe('eraseEverything', () => {
	it('zeroizes in-memory state BEFORE touching disk', async () => {
		const deps = makeDeps();
		await eraseEverything(deps);
		// The reload at the end is what usually removes cleartext from the page - but it is the LAST
		// step and every step before it can throw. Zeroize first so the window never opens.
		expect(deps.order.indexOf('relock')).toBeLessThan(deps.order.indexOf('wipeAll'));
	});

	it('still zeroizes when the erase throws partway and the reload is never reached', async () => {
		const deps = makeDeps({
			clearCaches: vi.fn(async () => {
				throw new Error('cache deletion failed');
			})
		});

		await expect(eraseEverything(deps)).rejects.toThrow('cache deletion failed');

		// The exact regression this guards: with the zeroize riding on the reload, a throw here left
		// the decrypted profile and any typed input resident on a page whose database was already gone.
		expect(deps.relock).toHaveBeenCalledOnce();
		expect(deps.reload).not.toHaveBeenCalled();
	});

	it('erases every layer, then reloads', async () => {
		const deps = makeDeps();
		await eraseEverything(deps);
		expect(deps.order).toEqual(['relock', 'wipeAll', 'clearStorage', 'clearCaches', 'reload']);
	});

	it('does nothing when the store wipe is unavailable', async () => {
		const deps = makeDeps({ wipeAll: null });
		await eraseEverything(deps);
		// Fail closed: a partial erase that clears caches but not the encrypted stores would strand
		// rows under a keystore epoch nothing can verify again.
		expect(deps.order).toEqual([]);
	});
});
