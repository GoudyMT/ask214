// The online request body is a structural allowlist, not a token blocklist (a blocklist is defeated by
// destructuring). The retrieve body is EXACTLY {query}; anything else is a PII-egress regression -- fail
// closed.

/** Build the retrieve request body -- exactly the trimmed query, nothing else. */
export function buildRetrieveBody(query: string): { query: string } {
	return { query: query.trim() };
}

/** Throw if `obj` carries any key outside `allowed` -- the structural egress guard. */
export function assertOnlyKeys(obj: Record<string, unknown>, allowed: string[]): void {
	const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
	if (extra.length > 0) throw new Error('E_PAYLOAD_EXTRA_KEYS');
}
