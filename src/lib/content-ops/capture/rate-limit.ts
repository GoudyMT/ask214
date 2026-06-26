type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

/**
 * A simple min-interval limiter (default 1 req/sec for polite scraping). The clock is injected
 * (`now` / `sleep`) so the unit test is deterministic - no real timers; the build script wires real
 * `Date.now` + a real sleep. The first acquire never waits (last = -Infinity).
 */
export function createRateLimiter(minIntervalMs: number, clock: Clock) {
	let last = -Infinity;
	return {
		async acquire(): Promise<void> {
			const wait = Math.max(0, minIntervalMs - (clock.now() - last));
			await clock.sleep(wait);
			last = clock.now();
		}
	};
}
