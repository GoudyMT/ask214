import { getContext, setContext } from 'svelte';
import type { InstallOutcome } from './install-prompt';

/**
 * Reactive, device-level install state. Set once in +layout (synchronously at component init, since
 * setContext must run during init) and populated in onMount, because the detection and the
 * beforeinstallprompt capture are browser-only. The Home nudge and the Settings control read it via
 * getInstallApp() and react to it.
 */
export type InstallApp = {
	/** A beforeinstallprompt was captured (Android / desktop Chromium) - a one-tap install is possible. */
	canPrompt: boolean;
	/** Running as an installed PWA - neither install surface shows. */
	installed: boolean;
	/** iOS / iPadOS Safari, where install is manual - the surfaces show Add-to-Home-Screen steps. */
	ios: boolean;
	/**
	 * A persist() grant is in effect. This is the SECOND durability leg: being installed exempts the
	 * storage from the 7-day inactivity timer, but only a granted persist() exempts it from
	 * storage-pressure eviction - so "installed" alone is not "safe". WebKit grants by heuristic.
	 */
	persisted: boolean;
	promptInstall: () => Promise<InstallOutcome>;
};

const KEY = Symbol('mtc-install-app');

export function setInstallApp(app: InstallApp): void {
	setContext(KEY, app);
}

export function getInstallApp(): InstallApp {
	return getContext<InstallApp>(KEY);
}
