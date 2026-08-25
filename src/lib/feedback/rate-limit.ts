export interface RateLimitState {
	day: string; // 'YYYY-MM-DD' (UTC)
	daySends: number; // total sends this day
	hour: string; // 'YYYY-MM-DDTHH' (UTC)
	ipSends: Record<string, number>; // per-IP sends this hour
}

export interface RateLimits {
	perIpPerHour: number;
	perDay: number;
}

// Defaults sit far above real feedback volume, so a legitimate user never hits them; only abuse does.
// Tunable in the Worker shell.
export const DEFAULT_LIMITS: RateLimits = { perIpPerHour: 5, perDay: 200 };

function utcDay(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 10);
}
function utcHour(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 13);
}

/**
 * Pure rate-limit decision (persistence lives in the DO shell, like breaker-state -> Breaker).
 * Rolls the day/hour buckets, then allows + increments only when under BOTH the per-IP hourly limit
 * and the global daily cap. The daily cap is the hard ceiling: it bounds total sends regardless of
 * how many IPs an attacker spreads across.
 */
export function checkRateLimit(
	prev: RateLimitState | null,
	nowMs: number,
	ip: string,
	limits: RateLimits
): { allowed: boolean; next: RateLimitState } {
	const day = utcDay(nowMs);
	const hour = utcHour(nowMs);
	const daySends = prev && prev.day === day ? prev.daySends : 0;
	const ipSends = prev && prev.hour === hour ? { ...prev.ipSends } : {};
	const ipCount = ipSends[ip] ?? 0;

	if (daySends >= limits.perDay || ipCount >= limits.perIpPerHour) {
		return { allowed: false, next: { day, daySends, hour, ipSends } };
	}

	ipSends[ip] = ipCount + 1;
	return { allowed: true, next: { day, daySends: daySends + 1, hour, ipSends } };
}
