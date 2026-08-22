/**
 * Owns the platform install affordance behind one seam so the Home nudge and the Settings control
 * share it. Android/Chromium/desktop fire a one-shot `beforeinstallprompt` that must be suppressed
 * and stashed so a later user gesture can trigger the real prompt; iOS never fires it (install is
 * manual there), so `canPrompt` stays false and the UI falls back to instructions.
 *
 * The event can fire during page load - before the app hydrates - and only once, so an app.html
 * inline script captures it onto window.__installPrompt; this controller reads that on init (via
 * initialPrompt) AND listens for later firings, so a returning user never loses the race. Pure and
 * dependency-injected so every path is unit-testable without a browser; onChange notifies the
 * composition root to re-read snapshot() into its reactive store.
 */

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

export type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

declare global {
	interface Window {
		__installPrompt?: BeforeInstallPromptEvent | null;
	}
}

/** Reads the install event the app.html early script may have captured before hydration. */
export function readCapturedPrompt(): BeforeInstallPromptEvent | null {
	return window.__installPrompt ?? null;
}

export type InstallEventTarget = {
	addEventListener: (type: string, cb: (e: Event) => void) => void;
	removeEventListener: (type: string, cb: (e: Event) => void) => void;
};

export type InstallControllerDeps = {
	target: InstallEventTarget;
	isInstalled: () => boolean;
	/** An install event captured before this controller existed (the app.html early script). */
	initialPrompt?: () => BeforeInstallPromptEvent | null;
	/** Called whenever canPrompt / installed changes, so the caller can re-read snapshot(). */
	onChange: () => void;
};

export type InstallSnapshot = { canPrompt: boolean; installed: boolean };

export type InstallController = {
	snapshot: () => InstallSnapshot;
	promptInstall: () => Promise<InstallOutcome>;
	destroy: () => void;
};

export function createInstallController(deps: InstallControllerDeps): InstallController {
	let deferred = deps.initialPrompt?.() ?? null;
	let installed = deps.isInstalled();

	const onBeforeInstallPrompt = (e: Event): void => {
		// Suppress the browser's own mini-infobar and keep the event for our own gesture-driven prompt.
		e.preventDefault();
		deferred = e as BeforeInstallPromptEvent;
		deps.onChange();
	};
	const onAppInstalled = (): void => {
		deferred = null;
		installed = true;
		deps.onChange();
	};
	deps.target.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
	deps.target.addEventListener('appinstalled', onAppInstalled);

	return {
		snapshot: () => ({ canPrompt: deferred !== null, installed }),
		async promptInstall() {
			const e = deferred;
			if (!e) return 'unavailable';
			// A beforeinstallprompt event can be used once; clear it up front so the button cannot
			// double-fire while the choice is pending.
			deferred = null;
			deps.onChange();
			try {
				await e.prompt();
				const { outcome } = await e.userChoice;
				return outcome;
			} catch {
				// A rejected prompt() (invoked outside a gesture, or already consumed) degrades quietly
				// rather than surfacing an unhandled rejection at the fire-and-forget call site.
				return 'unavailable';
			}
		},
		destroy() {
			deps.target.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
			deps.target.removeEventListener('appinstalled', onAppInstalled);
		}
	};
}
