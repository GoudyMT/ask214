/**
 * Clock-sanity helpers (pure). The profile carries a `lastSeenAt` high-water mark
 * so timeline math degrades gracefully when the device clock is wrong.
 *
 * `updateLastSeen` keeps the mark MONOTONIC and caps forward jumps at one year - a
 * malicious or broken clock cannot ratchet it to `Number.MAX_SAFE_INTEGER` and
 * poison every future comparison. `isClockBackward` flags a clock
 * that moved meaningfully backward so the UI can warn instead of silently corrupting.
 */
export const MAX_FUTURE_MS = 365 * 86_400_000;
const BACKWARD_GRACE_MS = 24 * 3600 * 1000;

/**
 * Advance the last-seen high-water mark.
 *
 * Args:
 *   prev: the stored high-water mark (ms epoch).
 *   now: the current time (ms epoch); defaults to `Date.now()`.
 *
 * Returns:
 *   The new mark: never below `prev` (monotonic), never above `prev + MAX_FUTURE_MS`.
 */
export function updateLastSeen(prev: number, now: number = Date.now()): number {
	// Uninitialized (first write): no prior mark to cap against, so take `now` as-is.
	// Without this, a 0 prev would clamp the first lastSeenAt to 0 + MAX_FUTURE_MS (~1971).
	if (prev <= 0) return now;
	const capped = Math.min(now, prev + MAX_FUTURE_MS);
	return Math.max(prev, capped);
}

/**
 * Report whether the clock appears to have moved backward past the grace window.
 *
 * Args:
 *   lastSeenAt: the stored high-water mark (ms epoch).
 *   now: the current time (ms epoch); defaults to `Date.now()`.
 *
 * Returns:
 *   True when `now` is more than 24h before `lastSeenAt`.
 */
export function isClockBackward(lastSeenAt: number, now: number = Date.now()): boolean {
	return now < lastSeenAt - BACKWARD_GRACE_MS;
}
