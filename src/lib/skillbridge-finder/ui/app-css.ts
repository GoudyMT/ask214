import appCss from '../../../app.css?inline';

/**
 * Puts the app's real stylesheet (tokens and base rules) on the page for a component test, which otherwise runs
 * without it; returns the function that takes it off again.
 */
export function useAppCss(): () => void {
	const style = document.createElement('style');
	style.textContent = appCss;
	document.head.append(style);
	return () => style.remove();
}
