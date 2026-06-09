/**
 * Map a SvelteKit route id to the shell content width applied by the root layout (the
 * --shell-width CSS variable on nav/main/footer). The whole shell widens together on a wide route;
 * every other route keeps the default 720px reading column. Pure + deterministic so the width rule
 * is unit-tested independently of the layout's CSS wiring.
 *
 * Source: Timeline Engine design spec (2026-06-03) section 7 (view, Option Y; Session 21 lock).
 */

const DEFAULT_SHELL_WIDTH = '720px';
const WIDE_SHELL_WIDTH = '1024px';

// Routes that render at the wider 1024px shell. One entry per wide route (single source of truth).
const WIDE_ROUTES: ReadonlySet<string> = new Set(['/timeline']);

export function shellWidthFor(routeId: string | null): string {
	return routeId !== null && WIDE_ROUTES.has(routeId) ? WIDE_SHELL_WIDTH : DEFAULT_SHELL_WIDTH;
}
