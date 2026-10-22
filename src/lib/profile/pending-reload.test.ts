import { describe, expect, it, vi } from 'vitest';

// A fresh module each time: the pending reload is the module's own state.
async function fresh() {
	vi.resetModules();
	return import('./pending-reload');
}

/** A timer the test fires by hand. */
function manualTimer() {
	const queued: { run: () => void; ms: number }[] = [];
	return {
		queued,
		wait: (run: () => void, ms: number) => void queued.push({ run, ms }),
		fire: () => queued.splice(0).forEach((t) => t.run())
	};
}

describe('a reload the app started on its own', () => {
	// A lock pressed in another tab just before that tab heard of the restore reaches this one after its reload began;
	// a reload already under way cannot be called back in WebKit, and its decrypt would undo the lock.
	it('waits out the grace, and a lock landing in it cancels the reload', async () => {
		const { startReload, stopReloadForLock, LOCK_GRACE_MS } = await fresh();
		const timer = manualTimer();
		const go = vi.fn();
		startReload(go, timer.wait);
		expect(timer.queued[0]?.ms).toBe(LOCK_GRACE_MS);
		expect(go).not.toHaveBeenCalled();
		expect(stopReloadForLock()).toBe(true);
		timer.fire();
		expect(go).not.toHaveBeenCalled();
	});

	// The everyday case: no lock, so the restored data loads.
	it('reloads when no lock came', async () => {
		const { startReload } = await fresh();
		const timer = manualTimer();
		const go = vi.fn();
		startReload(go, timer.wait);
		timer.fire();
		expect(go).toHaveBeenCalledOnce();
	});

	// An ordinary Lock, with no reload on its way, is no business of this; and a second lock finds nothing left.
	it('tells an ordinary lock there was nothing to cancel', async () => {
		const { startReload, stopReloadForLock } = await fresh();
		expect(stopReloadForLock()).toBe(false);
		startReload(() => {}, manualTimer().wait);
		expect(stopReloadForLock()).toBe(true);
		expect(stopReloadForLock()).toBe(false);
	});
});
