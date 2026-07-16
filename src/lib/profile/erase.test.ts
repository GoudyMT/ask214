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

	it('still zeroizes when a later step throws', async () => {
		const deps = makeDeps({
			clearCaches: vi.fn(async () => {
				throw new Error('cache deletion failed');
			})
		});

		await expect(eraseEverything(deps)).rejects.toThrow('cache deletion failed');

		// The exact regression this guards: with the zeroize riding on the reload, a throw here left
		// the decrypted profile and any typed input resident on a page whose database was already gone.
		expect(deps.relock).toHaveBeenCalledOnce();
	});

	it('reloads anyway once the stores are gone, even if a later layer fails', async () => {
		const deps = makeDeps({
			clearCaches: vi.fn(async () => {
				throw new Error('cache deletion failed');
			})
		});

		await expect(eraseEverything(deps)).rejects.toThrow('cache deletion failed');

		// The stores are already cleared, so the page is showing a profile that no longer exists:
		// hasProfile stays true, `locked` stays true, and Unlock is dead because load() finds no
		// keystore. Reloading is the only path back to a clean first-run - it must not ride on the
		// success of a lower-value layer like Cache Storage.
		expect(deps.reload).toHaveBeenCalledOnce();
	});

	it('does NOT reload when the store wipe itself failed - the data may still be there', async () => {
		const deps = makeDeps({
			wipeAll: vi.fn(async () => {
				throw new Error('transaction aborted');
			})
		});

		await expect(eraseEverything(deps)).rejects.toThrow('transaction aborted');

		// Reloading here would show a clean first-run screen over data that was never erased -
		// reporting success for a destructive operation that did not happen.
		expect(deps.reload).not.toHaveBeenCalled();
		expect(deps.clearStorage).not.toHaveBeenCalled();
	});

	it('erases every layer, then reloads', async () => {
		const deps = makeDeps();
		await eraseEverything(deps);
		expect(deps.order).toEqual(['relock', 'wipeAll', 'clearStorage', 'clearCaches', 'reload']);
	});

	it('refuses loudly when the store wipe is unavailable', async () => {
		const deps = makeDeps({ wipeAll: null });
		// Refusing is right - a partial erase that clears caches but not the encrypted stores would
		// strand rows under a keystore epoch nothing can verify again. Refusing SILENTLY is not: the
		// user asked for their data to be destroyed and has no way to tell that it was not.
		await expect(eraseEverything(deps)).rejects.toThrow('E_ERASE_UNAVAILABLE');
		expect(deps.order).toEqual([]);
	});
});
