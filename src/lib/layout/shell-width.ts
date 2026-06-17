/**
 * The shell content width applied by the root layout (the --shell-width CSS var on nav/main/footer).
 * ONE width for every route (Option 1, locked S25): the earlier per-route widths (Timeline 1024 / Ask
 * 760 / others 720) were unified after the page-to-page size swap felt jarring. The layout's `max-width`
 * + auto margins make it responsive - fluid (full width minus gutters) below this cap on phones/tablets,
 * capped here on larger screens; fluid headings (clamp, app.css) scale large text down on small screens.
 */
const SHELL_WIDTH = '900px';

// Per-route width overrides - EMPTY now (one width for every route). Add a route here to give it a
// different width later without touching the layout wiring (keeps the route-aware seam).
const ROUTE_SHELL_WIDTH: ReadonlyMap<string, string> = new Map();

export function shellWidthFor(routeId: string | null): string {
	return (routeId !== null && ROUTE_SHELL_WIDTH.get(routeId)) || SHELL_WIDTH;
}
