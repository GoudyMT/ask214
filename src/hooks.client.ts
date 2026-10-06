import type { ClientInit, HandleClientError } from '@sveltejs/kit';
import { installGlobalErrorSanitizer } from '$lib/log/global-errors';
import { safeLog } from '$lib/log/safelog';

/** Installed before the app starts, so an error thrown while it starts is caught too. */
export const init: ClientInit = () => {
	installGlobalErrorSanitizer(window);
};

/**
 * An error SvelteKit catches while loading or rendering. SvelteKit's default prints the raw error to the console,
 * where a message can carry what the user typed; this logs a static code instead. The page keeps SvelteKit's own
 * fixed message ("Internal Error", "Not Found"), which never contains the error's text.
 */
export const handleError: HandleClientError = ({ message }) => {
	safeLog({ code: 'E_INTERNAL' });
	return { message };
};
