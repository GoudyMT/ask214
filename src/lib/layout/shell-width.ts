/**
 * The shell content width applied by the root layout (the --shell-width CSS var on nav/main/footer).
 * ONE width for every route, so moving between pages never changes the column's width. The layout's
 * `max-width` + auto margins make it responsive - fluid (full width minus gutters) below this cap on
 * phones/tablets, capped here on larger screens; fluid headings (clamp, app.css) scale large text down on
 * small screens.
 */
const SHELL_WIDTH = '900px';

export function shellWidthFor(): string {
	return SHELL_WIDTH;
}
