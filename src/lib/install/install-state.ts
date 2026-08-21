/**
 * Detects whether the app is running as an installed PWA rather than a browser tab.
 *
 * The install nudge and the Settings install control both key off this: an installed user already
 * has WebKit's storage-eviction exemption, so neither surface shows for them. Two signals because no
 * single one covers every platform - most report `display-mode: standalone`, but iOS Safari does not
 * and exposes the non-standard `navigator.standalone` instead.
 */

export type StandaloneDeps = {
	displayModeStandalone: () => boolean;
	iosStandalone: () => boolean;
};

export const realStandaloneDeps: StandaloneDeps = {
	displayModeStandalone: () => window.matchMedia('(display-mode: standalone)').matches,
	iosStandalone: () => (navigator as Navigator & { standalone?: boolean }).standalone === true
};

export function isInstalled(deps: StandaloneDeps = realStandaloneDeps): boolean {
	return deps.displayModeStandalone() || deps.iosStandalone();
}

export type IOSDeps = {
	userAgent: () => string;
	maxTouchPoints: () => number;
};

export const realIOSDeps: IOSDeps = {
	userAgent: () => navigator.userAgent,
	maxTouchPoints: () => navigator.maxTouchPoints
};

/**
 * True on iOS / iPadOS Safari, where install is manual (Share -> Add to Home Screen) and no
 * beforeinstallprompt fires. iPadOS 13+ reports a "Macintosh" user agent, so a Mac UA with touch
 * points is treated as an iPad. This is a heuristic used only to decide whether to show an install
 * hint - a false negative merely suppresses the hint and never gates anything security-relevant.
 */
export function isIOS(deps: IOSDeps = realIOSDeps): boolean {
	return (
		/iPad|iPhone|iPod/.test(deps.userAgent()) ||
		(/Macintosh/.test(deps.userAgent()) && deps.maxTouchPoints() > 1)
	);
}
