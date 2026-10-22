/**
 * A reload the app starts on its own: another tab replaced the data, or this tab restored it. A reload decrypts again,
 * so a Lock arriving after it started would be undone - and one can still be on its way: pressed in another tab just
 * before that tab heard of the restore, it reaches this one a cross-tab hop or two later (measured: 4 ms in Chromium,
 * 30 ms in WebKit). A started reload cannot be called back in every engine, so the reload waits out a short grace
 * first; a lock that lands in it cancels the reload, and the tab reloads on its Unlock instead, the path a tab that
 * was already locked takes.
 */
export const LOCK_GRACE_MS = 150;

let pending: (() => void) | null = null;

export function startReload(
	go: () => void,
	wait: (run: () => void, ms: number) => unknown = setTimeout
): void {
	const run = () => {
		if (pending !== run) return;
		pending = null;
		go();
	};
	pending = run;
	wait(run, LOCK_GRACE_MS);
}

/** Cancels a reload still in its grace, for a lock; true when there was one, so the caller reloads on Unlock instead. */
export function stopReloadForLock(): boolean {
	if (pending === null) return false;
	pending = null;
	return true;
}
