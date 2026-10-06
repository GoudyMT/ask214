import { safeLog } from './safelog';

/**
 * Replace any error that escapes to the window with a static code. A thrown message can carry what the user typed,
 * so the browser's own report (the console line, and anything that reads it) is stopped and only E_INTERNAL
 * reaches the safe log. Returns a function that removes both listeners.
 */
export function installGlobalErrorSanitizer(target: Window): () => void {
	const report = (e: Event) => {
		e.preventDefault();
		safeLog({ code: 'E_INTERNAL' });
	};
	target.addEventListener('error', report);
	target.addEventListener('unhandledrejection', report);
	return () => {
		target.removeEventListener('error', report);
		target.removeEventListener('unhandledrejection', report);
	};
}
