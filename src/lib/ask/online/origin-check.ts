// Same-origin POSTs always carry an Origin header; we allow only our own app origins. Documented as
// anti-hotlink / CSRF defense-in-depth, NOT an anti-automation control (Origin is spoofable off-browser) --
// abuse defense is the rate-limit + circuit-breaker.
export function isAllowedOrigin(origin: string | null, allowed: string[]): boolean {
	return origin !== null && allowed.includes(origin);
}
