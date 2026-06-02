/**
 * Cloudflare `_headers` policy parser (Phase 2 plan Milestone P1b).
 *
 * Closes the "_headers has ZERO automated coverage" gap: the edge headers (HSTS,
 * Referrer-Policy, per-route Cache-Control) are applied by Cloudflare at deploy and are NOT
 * served by `vite preview`, so they cannot be asserted via the live E2E. This pure parser lets
 * a vitest test assert the file's directives directly (pre-commit + CI), cross-platform. Live
 * edge validation of the served headers stays in the deferred cross-browser launch gate.
 */

/**
 * Parse a Cloudflare `_headers` file into a map of path -> { headerName: value }.
 *
 * Format: a path line begins at column 0 with `/`; the header lines beneath it are indented
 * `Name: value` pairs, until the next path line. Blank and `#` comment lines are ignored.
 *
 * Args:
 *   content: the raw `_headers` file text.
 *
 * Returns:
 *   Map keyed by path (e.g. '/*', '/wizard'); each value is that path's headers.
 */
export function parseHeadersFile(content: string): Map<string, Record<string, string>> {
	const blocks = new Map<string, Record<string, string>>();
	let current: string | null = null;
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) {
			continue;
		}
		if (line.startsWith('/')) {
			// Path line (column 0). Header lines are indented, so they never match here.
			current = trimmed;
			blocks.set(current, {});
		} else if (current !== null) {
			const idx = line.indexOf(':');
			if (idx === -1) {
				continue;
			}
			const block = blocks.get(current);
			if (block) {
				block[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}
	}
	return blocks;
}
