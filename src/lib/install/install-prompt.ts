/**
 * Owns the platform install affordance behind one seam so the Home nudge and the Settings control
 * share it. Android/Chromium/desktop fire a one-shot `beforeinstallprompt` that must be suppressed
 * and stashed so a later user gesture can trigger the real prompt; iOS never fires it (install is
 * manual there), so `canPrompt` stays false and the UI falls back to instructions.
 *
 * Pure and dependency-injected: the event target and the installed check are injected, so every
 * path is unit-testable without a browser. The Svelte reactivity is a thin `subscribe` wrapper the
 * composition root wires into a reactive store.
 */

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export type InstallControllerDeps = {
	target: { addEventListener: (type: string, cb: (e: Event) => void) => void };
	isInstalled: () => boolean;
};

export type InstallSnapshot = { canPrompt: boolean; installed: boolean };

export type InstallController = {
	snapshot: () => InstallSnapshot;
	subscribe: (cb: () => void) => () => void;
	promptInstall: () => Promise<InstallOutcome>;
};

export function createInstallController(deps: InstallControllerDeps): InstallController {
	let deferred: BeforeInstallPromptEvent | null = null;
	let installed = deps.isInstalled();
	const listeners = new Set<() => void>();
	const notify = (): void => {
		for (const l of listeners) l();
	};

	deps.target.addEventListener('beforeinstallprompt', (e) => {
		// Suppress the browser's own mini-infobar and keep the event for our own gesture-driven prompt.
		e.preventDefault();
		deferred = e as BeforeInstallPromptEvent;
		notify();
	});
	deps.target.addEventListener('appinstalled', () => {
		deferred = null;
		installed = true;
		notify();
	});

	return {
		snapshot: () => ({ canPrompt: deferred !== null, installed }),
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		async promptInstall() {
			const e = deferred;
			if (!e) return 'unavailable';
			// A beforeinstallprompt event can be used once; clear it up front so the button cannot
			// double-fire while the choice is pending.
			deferred = null;
			notify();
			await e.prompt();
			const { outcome } = await e.userChoice;
			return outcome;
		}
	};
}
