/**
 * Retrieve-Worker config-invariant policy (ADR-025 item 7).
 *
 * Closes the "claimed CI-gated but nothing reads the Worker config" gap: the observability and
 * telemetry settings that keep a user query out of edge logs live in
 * `workers/retrieve/wrangler.jsonc`, and no test asserted them, so a future edit re-enabling
 * observability (or adding Logpush, an Analytics Engine binding, or a tail consumer) would ship
 * silently. These pure helpers let a vitest test assert the committed config directly, in the node
 * unit gate. The related "never routed through AI Gateway" invariant is a call-site property (the
 * `AI.run` options), asserted against the Worker source in the test rather than here.
 */

/**
 * Strip `//` line comments and block comments from JSONC, preserving comment markers that appear
 * inside string literals.
 *
 * Wrangler config is JSONC, which `JSON.parse` rejects. A strip that ignored string state would
 * corrupt a value containing `//` (a URL, the schema-relative path), so this walks the text and
 * tracks whether it is inside a string.
 *
 * Args:
 *   raw: the raw JSONC text.
 *
 * Returns:
 *   Comment-free, trailing-comma-free text safe to pass to `JSON.parse`.
 */
export function stripJsoncComments(raw: string): string {
	let out = '';
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw.charAt(i);
		const next = raw.charAt(i + 1);
		if (inLine) {
			if (ch === '\n') {
				inLine = false;
				out += ch;
			}
			continue;
		}
		if (inBlock) {
			if (ch === '*' && next === '/') {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += ch;
			if (ch === '\\') {
				// Copy the escaped character verbatim so an escaped quote does not end the string.
				out += next;
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === '/' && next === '/') {
			inLine = true;
			i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlock = true;
			i++;
			continue;
		}
		if (ch === '}' || ch === ']') {
			// Drop a trailing comma (legal JSONC, rejected by JSON.parse). Any string's closing quote
			// already terminated `out`, so this cannot reach a comma inside a string value.
			out = out.replace(/,\s*$/, '');
		}
		out += ch;
	}
	return out;
}

/** A parsed wrangler config; only the keys this policy inspects are named. */
export interface WorkerConfig {
	observability?: {
		enabled?: boolean;
		logs?: { enabled?: boolean };
		traces?: { enabled?: boolean };
	};
	logpush?: unknown;
	[key: string]: unknown;
}

/**
 * Return a message for each retrieve-Worker config invariant that is not met.
 *
 * Invariants (ADR-025 item 7, config surface): edge observability is explicitly OFF (top-level enabled plus the nested logs/traces sub-toggles); no Logpush;
 * no Analytics Engine binding; no tail consumer. Each would route a query into a log or trace the
 * zero-retention model forbids. Observability must be explicitly `false`, not merely absent -- the
 * platform default is not the invariant.
 *
 * Args:
 *   config: the parsed `wrangler.jsonc` object.
 *
 * Returns:
 *   Violation messages; empty when the config is compliant.
 */
export function findWorkerConfigViolations(config: WorkerConfig): string[] {
	const violations: string[] = [];
	const obs = config.observability;
	if (obs?.enabled !== false) {
		violations.push('observability.enabled must be explicitly false');
	}
	if (obs?.logs?.enabled === true || obs?.traces?.enabled === true) {
		violations.push(
			'observability.logs / traces must not be enabled (a query would reach edge logs)'
		);
	}
	if ('tail_consumers' in config) {
		violations.push('tail_consumers must be absent');
	}
	if ('analytics_engine_datasets' in config) {
		violations.push('analytics_engine_datasets must be absent');
	}
	if (config.logpush === true) {
		violations.push('logpush must not be enabled');
	}
	return violations;
}
