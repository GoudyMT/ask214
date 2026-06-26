import { describe, test, expect } from 'vitest';
import { createRateLimiter } from './rate-limit';

describe('createRateLimiter', () => {
	test('spaces successive acquires by at least the interval', async () => {
		let clock = 1000;
		const sleeps: number[] = [];
		const limiter = createRateLimiter(1000, {
			now: () => clock,
			sleep: async (ms) => {
				sleeps.push(ms);
				clock += ms; // advance the virtual clock by the slept amount
			}
		});
		await limiter.acquire(); // first: no wait
		await limiter.acquire(); // immediately after -> must wait the full interval
		expect(sleeps).toEqual([0, 1000]);
	});

	test('does not wait when the interval has already elapsed', async () => {
		let clock = 0;
		const sleeps: number[] = [];
		const limiter = createRateLimiter(1000, {
			now: () => clock,
			sleep: async (ms) => {
				sleeps.push(ms);
			}
		});
		await limiter.acquire(); // wait 0
		clock = 5000; // 5s later
		await limiter.acquire(); // interval long elapsed -> wait 0
		expect(sleeps).toEqual([0, 0]);
	});
});
