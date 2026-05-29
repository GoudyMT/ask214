import { describe, it, expect } from 'vitest';
import { updateLastSeen, MAX_FUTURE_MS, isClockBackward } from './clock';

describe('updateLastSeen', () => {
	it('advances when now > prev (monotonic)', () => {
		expect(updateLastSeen(1000, 2000)).toBe(2000);
	});

	it('refuses to retreat (stays at prev) when now < prev', () => {
		expect(updateLastSeen(2000, 1000)).toBe(2000);
	});

	it('caps now at prev + MAX_FUTURE_MS (resolves F-C-7)', () => {
		const prev = 1000;
		const malicious = prev + MAX_FUTURE_MS * 2;
		expect(updateLastSeen(prev, malicious)).toBe(prev + MAX_FUTURE_MS);
	});

	it('MAX_FUTURE_MS is 1 year', () => {
		expect(MAX_FUTURE_MS).toBe(365 * 86_400_000);
	});

	it('returns now when prev is uninitialized (0): no prior mark to cap against', () => {
		const now = 1_700_000_000_000; // far beyond MAX_FUTURE_MS; must NOT clamp to ~1971
		expect(updateLastSeen(0, now)).toBe(now);
	});
});

describe('isClockBackward', () => {
	it('returns true when now is more than 24h before lastSeenAt', () => {
		const lastSeen = 1_000_000_000_000;
		const nowEarlier = lastSeen - 25 * 3600 * 1000;
		expect(isClockBackward(lastSeen, nowEarlier)).toBe(true);
	});

	it('returns false within the 24h grace window', () => {
		const lastSeen = 1_000_000_000_000;
		const nowEarlier = lastSeen - 23 * 3600 * 1000;
		expect(isClockBackward(lastSeen, nowEarlier)).toBe(false);
	});

	it('returns false when now > lastSeen', () => {
		expect(isClockBackward(1000, 2000)).toBe(false);
	});
});
