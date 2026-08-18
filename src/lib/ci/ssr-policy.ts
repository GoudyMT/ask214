/**
 * PII-route SSR policy (ADR-004).
 *
 * `export const ssr = false` is the load-bearing control that keeps a PII route's HTML free of
 * personal data: SvelteKit then serves an empty shell and the profile/timeline data renders
 * client-side from the encrypted in-memory rune. The service worker caches HTML documents
 * network-first for offline, so a PII route that ever server-rendered real data would land in Cache
 * Storage. This pure checker lets a vitest test assert every profile-touching route disables SSR, so
 * the control is enforced rather than merely documented.
 */

/**
 * Whether a route module source disables server-side rendering (`export const ssr = false`).
 *
 * Args:
 *   source: the raw text of a route's `+page.ts` / `+layout.ts`.
 *
 * Returns:
 *   true when the source exports `ssr = false`.
 */
export function disablesSsr(source: string): boolean {
	// Strip comments first so a commented-out `// export const ssr = false` does not read as active.
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	return /export\s+const\s+ssr\s*=\s*false\b/.test(code);
}
