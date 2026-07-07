/**
 * Activity-reset idle timer. When `thresholdMs` elapses with no `recordActivity()`
 * call, `onIdle` fires once (it does not repeat until the timer is restarted). The
 * app-init layer binds DOM activity events to `recordActivity()` and points `onIdle`
 * at the relock action - this factory stays free of any DOM dependency.
 *
 * No timestamp quantization: `lastActivity` is module-private, never
 * exported or broadcast, so the keystroke-cadence side-channel does not exist.
 */
export type IdleTimerOptions = {
	thresholdMs: number;
	onIdle: () => void;
};

export type IdleTimer = {
	start(): void;
	stop(): void;
	recordActivity(): void;
};

export function createIdleTimer(opts: IdleTimerOptions): IdleTimer {
	let lastActivity = 0;
	let handle: ReturnType<typeof setTimeout> | null = null;
	let stopped = true;

	// Self-rescheduling check: setTimeout for the full threshold, then on wake compare
	// real elapsed time against lastActivity. A reset just moves lastActivity forward,
	// so the wake either fires onIdle or reschedules for the remaining interval.
	function scheduleCheck(): void {
		if (handle) clearTimeout(handle);
		handle = setTimeout(() => {
			if (stopped) return;
			if (Date.now() - lastActivity >= opts.thresholdMs) {
				opts.onIdle();
			} else {
				scheduleCheck();
			}
		}, opts.thresholdMs);
	}

	return {
		start(): void {
			stopped = false;
			lastActivity = Date.now();
			scheduleCheck();
		},
		stop(): void {
			stopped = true;
			if (handle) {
				clearTimeout(handle);
				handle = null;
			}
		},
		recordActivity(): void {
			if (stopped) return;
			lastActivity = Date.now();
			scheduleCheck();
		}
	};
}
