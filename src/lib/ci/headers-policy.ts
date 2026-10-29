/**
 * Cloudflare `_headers` policy parser.
 *
 * Cloudflare applies the file to the static files it serves; the server hook applies the same file to the pages the
 * Worker renders, through these functions. A vitest test asserts the file's directives directly, and the E2E asserts
 * a rendered page's headers.
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

/**
 * The headers `_headers` gives one path: every block whose path matches it, in file order.
 *
 * A block path ending in `/*` matches everything under its folder (`/*` matches every path); any other block path
 * matches only itself. This is the subset of Cloudflare's matching the file uses.
 *
 * Args:
 *   rules: the parsed file, from parseHeadersFile.
 *   pathname: the request's path, e.g. '/settings/backup'.
 *
 * Returns:
 *   The merged headers; a later block's value wins over an earlier one's.
 */
export function headersFor(
	rules: Map<string, Record<string, string>>,
	pathname: string
): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [path, headers] of rules) {
		const matches = path.endsWith('/*')
			? pathname.startsWith(path.slice(0, -1))
			: pathname === path;
		if (matches) Object.assign(merged, headers);
	}
	return merged;
}
