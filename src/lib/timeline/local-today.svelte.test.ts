import { flushSync } from 'svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { LocalToday, msToNextLocalMidnight } from './local-today.svelte';
import { localTodayIso } from './day-math';

const HOUR_MS = 3_600_000;

describe('msToNextLocalMidnight', () => {
	it('counts the seconds left in the day', () => {
		expect(msToNextLocalMidnight(new Date(2026, 5, 15, 23, 59, 50))).toBe(10_000);
	});

	it('counts a whole day from midnight itself', () => {
		expect(msToNextLocalMidnight(new Date(2026, 5, 15, 0, 0, 0))).toBe(24 * HOUR_MS);
	});

	// The zone is fixed to America/Los_Angeles by the test config: it springs forward on 2026-03-08 (a 23-hour day).
	it('is 22.5 hours from 00:30 on the day the clocks spring forward', () => {
		expect(msToNextLocalMidnight(new Date(2026, 2, 8, 0, 30, 0))).toBe(22.5 * HOUR_MS);
	});

	// ... and falls back on 2026-11-01 (a 25-hour day).
	it('is 24.5 hours from 00:30 on the day the clocks fall back', () => {
		expect(msToNextLocalMidnight(new Date(2026, 10, 1, 0, 30, 0))).toBe(24.5 * HOUR_MS);
	});
});

describe('LocalToday', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function fakeClock(at: Date): void {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		vi.setSystemTime(at);
	}

	it('reads the clock at the moment of the read', () => {
		fakeClock(new Date(2026, 5, 15, 12, 0, 0));
		const clock = new LocalToday();
		expect(localTodayIso(clock.now)).toBe('2026-06-15');
		vi.setSystemTime(new Date(2026, 5, 16, 12, 0, 0));
		expect(localTodayIso(clock.now)).toBe('2026-06-16');
	});

	it('re-runs an effect that reads it once at each local midnight, and not before', () => {
		fakeClock(new Date(2026, 5, 15, 23, 59, 50));
		const clock = new LocalToday();
		const seen: string[] = [];
		const stop = $effect.root(() => {
			$effect(() => {
				seen.push(localTodayIso(clock.now));
			});
		});
		flushSync();
		expect(seen).toEqual(['2026-06-15']);

		vi.advanceTimersByTime(9_999);
		flushSync();
		expect(seen).toEqual(['2026-06-15']);

		vi.advanceTimersByTime(1);
		flushSync();
		expect(seen).toEqual(['2026-06-15', '2026-06-16']);

		// The timer is armed again: the next midnight turns the day too.
		vi.advanceTimersByTime(24 * HOUR_MS - 1);
		flushSync();
		expect(seen).toEqual(['2026-06-15', '2026-06-16']);
		vi.advanceTimersByTime(1);
		flushSync();
		expect(seen).toEqual(['2026-06-15', '2026-06-16', '2026-06-17']);
		stop();
	});

	it('keeps one timer for any number of readers', () => {
		fakeClock(new Date(2026, 5, 15, 23, 59, 50));
		const clock = new LocalToday();
		const stop = $effect.root(() => {
			$effect(() => void clock.now);
			$effect(() => void clock.now);
		});
		flushSync();
		expect(vi.getTimerCount()).toBe(1);
		stop();
	});

	it('clears its timer once nothing reads it', async () => {
		fakeClock(new Date(2026, 5, 15, 23, 59, 50));
		const clock = new LocalToday();
		const stop = $effect.root(() => {
			$effect(() => void clock.now);
		});
		flushSync();
		expect(vi.getTimerCount()).toBe(1);
		stop();
		// Svelte ends a subscription in a microtask after the last reader goes.
		await Promise.resolve();
		expect(vi.getTimerCount()).toBe(0);
	});
});
