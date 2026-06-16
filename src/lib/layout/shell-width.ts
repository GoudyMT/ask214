/**
 * Map a SvelteKit route id to the shell content width applied by the root layout (the
 * --shell-width CSS variable on nav/main/footer). Each route maps to its content width - a wide board
 * route, a mid-width search route, or the default reading column. Pure + deterministic so the width
 * rule is unit-tested independently of the layout's CSS wiring.
 *
 * Source: Timeline Engine design spec (2026-06-03) section 7 (view, Option Y; Session 21 lock).
 */

const DEFAULT_SHELL_WIDTH = '720px';

// Per-route shell-width overrides; any route not listed uses DEFAULT_SHELL_WIDTH. Single source of
// truth - one entry per non-default route. Timeline is wide (1024) for its multi-column board; Ask is
// 760 for comfortable search + reading (Corpus Ask UI spec 2026-06-11 section 9).
const ROUTE_SHELL_WIDTH: ReadonlyMap<string, string> = new Map([
	['/timeline', '1024px'],
	['/ask', '760px']
]);

export function shellWidthFor(routeId: string | null): string {
	if (routeId === null) return DEFAULT_SHELL_WIDTH;
	return ROUTE_SHELL_WIDTH.get(routeId) ?? DEFAULT_SHELL_WIDTH;
}
