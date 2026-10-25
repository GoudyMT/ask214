/**
 * Activity-reset idle timer. When `thresholdMs` elapses with no `recordActivity()`
 * call, `onIdle` fires once (it does not repeat until the timer is restarted). The
 * app-init layer binds DOM activity events to `recordActivity()` and points `onIdle`
 * at the relock action - this factory stays free of any DOM dependency.
 *
 * No timestamp quantization: `lastActivity` is module-private, never
 * exported or broadcast, so the keystroke-cadence side-channel does not exist.
 *
 * A phone that sleeps runs no timeout, so the time since the last activity is read from two clocks and the larger
 * wins: the wall clock can be set back, and the monotonic one may not count a sleep.
 */
export type IdleTimerOptions = {
	thresholdMs: number;
	onIdle: () => void;
	/** The wall clock; injected so a test can move it. */
	now?: () => number;
	/** The monotonic clock; injected so a test can move it. */
	perfNow?: () => number;
};

export type IdleTimer = {
	start(): void;
	stop(): void;
	recordActivity(): void;
};

export function createIdleTimer(opts: IdleTimerOptions): IdleTimer {
	// Read at call time, not captured, so a faked global clock is honoured.
	const now = opts.now ?? (() => Date.now());
	const perfNow = opts.perfNow ?? (() => performance.now());
	let lastWall = 0;
	let lastPerf = 0;
	let fired = false;
	let handle: ReturnType<typeof setTimeout> | null = null;
	let stopped = true;

	// While the page runs, the monotonic clock is the trusted one, so a wall clock set back counts as no time.
	function elapsed(): number {
		return Math.max(0, now() - lastWall, perfNow() - lastPerf);
	}

	function reset(): void {
		lastWall = now();
		lastPerf = perfNow();
		fired = false;
	}

	function idle(): void {
		fired = true;
		opts.onIdle();
	}

	// Self-rescheduling check: setTimeout for the full threshold, then on wake compare
	// real elapsed time against the last activity. A reset just moves the last activity forward,
	// so the wake either fires onIdle or reschedules for the remaining interval.
	function scheduleCheck(): void {
		if (handle) clearTimeout(handle);
		handle = setTimeout(() => {
			if (stopped) return;
			if (elapsed() >= opts.thresholdMs) {
				idle();
			} else {
				scheduleCheck();
			}
		}, opts.thresholdMs);
	}

	return {
		start(): void {
			stopped = false;
			reset();
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
			// A timeout that never ran (the page slept) leaves the quiet unnoticed until now: lock first, then count
			// from this touch. Not again after the timer's own lock - this touch may be the one that unlocks.
			if (!fired && elapsed() >= opts.thresholdMs) idle();
			reset();
			scheduleCheck();
		}
	};
}
