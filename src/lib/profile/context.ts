import { getContext, setContext } from 'svelte';
import type { CapabilityCause } from '../crypto/capability';
import type { ProfileStore } from './store.svelte';

export type AppStatus = 'loading' | 'ready' | 'unsupported';

/**
 * Reactive app-wide container for the profile subsystem. Set ONCE in +layout (synchronously
 * at component init, since setContext must run during init), then populated by the async
 * app-init. Components read it via getProfileApp() and react to status/store changes.
 *
 * Source: Milestone L2 app-init wiring (Option B: store provisioned via context, not a
 * module singleton).
 */
export type ProfileApp = {
	status: AppStatus;
	store: ProfileStore | null;
	cause: CapabilityCause | null;
};

const KEY = Symbol('mtc-profile-app');

export function setProfileApp(app: ProfileApp): void {
	setContext(KEY, app);
}

export function getProfileApp(): ProfileApp {
	return getContext<ProfileApp>(KEY);
}
