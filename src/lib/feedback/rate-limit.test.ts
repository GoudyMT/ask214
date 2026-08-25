import { describe, it, expect } from 'vitest';
import { checkRateLimit, type RateLimitState } from './rate-limit';

const LIMITS = { perIpPerHour: 5, perDay: 200 };
const T = Date.UTC(2026, 7, 24, 15, 30); // fixed instant

describe('checkRateLimit', () => {
	it('allows and increments when under both limits', () => {
		const r = checkRateLimit(null, T, '1.2.3.4', LIMITS);
		expect(r.allowed).toBe(true);
		expect(r.next.daySends).toBe(1);
		expect(r.next.ipSends['1.2.3.4']).toBe(1);
	});

	it('blocks a per-IP flood in the same hour (no increment past the cap)', () => {
		let state: RateLimitState | null = null;
		for (let i = 0; i < 5; i++) state = checkRateLimit(state, T, 'ip', LIMITS).next;
		const r = checkRateLimit(state, T, 'ip', LIMITS);
		expect(r.allowed).toBe(false);
		expect(r.next.ipSends['ip']).toBe(5);
	});

	it('lets a different IP through even when the first is capped', () => {
		let state: RateLimitState | null = null;
		for (let i = 0; i < 5; i++) state = checkRateLimit(state, T, 'a', LIMITS).next;
		expect(checkRateLimit(state, T, 'b', LIMITS).allowed).toBe(true);
	});

	it('resets per-IP counts in a new hour', () => {
		let state: RateLimitState | null = null;
		for (let i = 0; i < 5; i++) state = checkRateLimit(state, T, 'ip', LIMITS).next;
		expect(checkRateLimit(state, T, 'ip', LIMITS).allowed).toBe(false);
		const nextHour = T + 60 * 60 * 1000;
		const r = checkRateLimit(state, nextHour, 'ip', LIMITS);
		expect(r.allowed).toBe(true);
		expect(r.next.ipSends['ip']).toBe(1);
	});

	it('blocks once the global daily cap is reached, across IPs', () => {
		const limits = { perIpPerHour: 1000, perDay: 3 };
		let state: RateLimitState | null = null;
		state = checkRateLimit(state, T, 'a', limits).next;
		state = checkRateLimit(state, T, 'b', limits).next;
		state = checkRateLimit(state, T, 'c', limits).next;
		expect(checkRateLimit(state, T, 'd', limits).allowed).toBe(false);
	});

	it('resets the daily count on a new day', () => {
		const limits = { perIpPerHour: 1000, perDay: 1 };
		const state = checkRateLimit(null, T, 'a', limits).next;
		expect(checkRateLimit(state, T, 'b', limits).allowed).toBe(false);
		const nextDay = T + 24 * 60 * 60 * 1000;
		expect(checkRateLimit(state, nextDay, 'b', limits).allowed).toBe(true);
	});
});
