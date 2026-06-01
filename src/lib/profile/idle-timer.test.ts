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
