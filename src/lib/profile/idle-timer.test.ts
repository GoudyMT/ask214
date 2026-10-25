import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIdleTimer } from './idle-timer';

describe('createIdleTimer', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('fires onIdle after the threshold elapses', () => {
		const onIdle = vi.fn();
		const timer = createIdleTimer({ thresholdMs: 1000, onIdle });
		timer.start();
		vi.advanceTimersByTime(1100);
		expect(onIdle).toHaveBeenCalledTimes(1);
		timer.stop();
	});

	it('resets the countdown on recordActivity', () => {
		const onIdle = vi.fn();
		const timer = createIdleTimer({ thresholdMs: 1000, onIdle });
		timer.start();
		vi.advanceTimersByTime(900);
		timer.recordActivity();
		vi.advanceTimersByTime(900);
		expect(onIdle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(onIdle).toHaveBeenCalledTimes(1);
		timer.stop();
	});

	it('does not fire onIdle after stop()', () => {
		const onIdle = vi.fn();
		const timer = createIdleTimer({ thresholdMs: 1000, onIdle });
		timer.start();
		timer.stop();
		vi.advanceTimersByTime(2000);
		expect(onIdle).not.toHaveBeenCalled();
	});

	it('fires only once per idle period (no repeat until restart)', () => {
		const onIdle = vi.fn();
		const timer = createIdleTimer({ thresholdMs: 1000, onIdle });
		timer.start();
		vi.advanceTimersByTime(3000);
		expect(onIdle).toHaveBeenCalledTimes(1);
		timer.stop();
	});

	it('ignores recordActivity while stopped', () => {
		const onIdle = vi.fn();
		const timer = createIdleTimer({ thresholdMs: 1000, onIdle });
		timer.recordActivity();
		vi.advanceTimersByTime(2000);
		expect(onIdle).not.toHaveBeenCalled();
	});
});

// A phone that sleeps runs no timer, so the first touch after a long quiet is the only moment the code can notice
// the time away. The clocks are injected and the timers never advance, which is exactly that sleep.
describe('createIdleTimer, the first activity after a long quiet', () => {
	const THRESHOLD = 15 * 60_000;
	const MINUTE = 60_000;

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup() {
		const clock = { wall: 1_000_000_000, perf: 5_000 };
		const onIdle = vi.fn();
		const timer = createIdleTimer({
			thresholdMs: THRESHOLD,
			onIdle,
			now: () => clock.wall,
			perfNow: () => clock.perf
		});
		timer.start();
		return { clock, onIdle, timer };
	}

	it('locks before it resets when the quiet reached the threshold', () => {
		const { clock, onIdle, timer } = setup();
		clock.wall += 16 * MINUTE;
		clock.perf += 16 * MINUTE;
		timer.recordActivity();
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it('only resets when the quiet was shorter, and counts from the reset', () => {
		const { clock, onIdle, timer } = setup();
		clock.wall += 14 * MINUTE;
		clock.perf += 14 * MINUTE;
		timer.recordActivity();
		expect(onIdle).not.toHaveBeenCalled();
		clock.wall += 14 * MINUTE;
		clock.perf += 14 * MINUTE;
		timer.recordActivity();
		expect(onIdle).not.toHaveBeenCalled();
	});

	it('counts the larger of the two clocks', () => {
		const wallOnly = setup();
		wallOnly.clock.wall += 16 * MINUTE;
		wallOnly.clock.perf += 1 * MINUTE;
		wallOnly.timer.recordActivity();
		expect(wallOnly.onIdle).toHaveBeenCalledTimes(1);

		const perfOnly = setup();
		perfOnly.clock.wall += 1 * MINUTE;
		perfOnly.clock.perf += 16 * MINUTE;
		perfOnly.timer.recordActivity();
		expect(perfOnly.onIdle).toHaveBeenCalledTimes(1);
	});

	// While the page runs, performance.now is the trusted clock: a wall clock set back must not make a person who
	// is typing look idle, nor hide that they were.
	it('counts a wall clock that moved back as no time, not as a long quiet', () => {
		const { clock, onIdle, timer } = setup();
		clock.wall -= 60 * MINUTE;
		clock.perf += 1 * MINUTE;
		timer.recordActivity();
		expect(onIdle).not.toHaveBeenCalled();
	});

	// After the timer has locked, the person's next touch is to unlock: locking again then would shut the screen
	// they are reaching for.
	it('does not lock a second time on the touch that follows its own lock', () => {
		const { clock, onIdle, timer } = setup();
		clock.wall += THRESHOLD;
		clock.perf += THRESHOLD;
		vi.advanceTimersByTime(THRESHOLD);
		expect(onIdle).toHaveBeenCalledTimes(1);
		clock.wall += 5 * MINUTE;
		clock.perf += 5 * MINUTE;
		timer.recordActivity();
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it('wakes on the larger clock too, not only the wall clock', () => {
		const { clock, onIdle } = setup();
		clock.perf += THRESHOLD;
		vi.advanceTimersByTime(THRESHOLD);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});
});
