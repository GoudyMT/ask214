import { getContext, setContext } from 'svelte';
import type { CapabilityCause } from '../crypto/capability';
import type { ProfileStore } from './store.svelte';
import type { TimelineStateStore } from '../timeline';
import type { CalendarSyncStore } from '../calendar/store.svelte';

export type AppStatus = 'loading' | 'ready' | 'unsupported';

/**
 * Reactive app-wide container for the profile subsystem. Set ONCE in +layout (synchronously
 * at component init, since setContext must run during init), then populated by the async
 * app-init. Components read it via getProfileApp() and react to status/store changes.
 *
 * Design (Option B): the store is provisioned via context, not a module singleton.
 */
export type ProfileApp = {
	status: AppStatus;
	store: ProfileStore | null;
	timeline: TimelineStateStore | null;
	calendar: CalendarSyncStore | null;
	cause: CapabilityCause | null;
	/**
	 * Erase every store on the device. An app-level act, not a store-level one: it must clear stores
	 * by registry name, because a store that failed to provision is exactly the one whose rows would
	 * outlive the wipe and then block their own recovery. Null until app-init resolves.
	 */
	wipeAll: (() => Promise<void>) | null;
};

const KEY = Symbol('mtc-profile-app');

export function setProfileApp(app: ProfileApp): void {
	setContext(KEY, app);
}

export function getProfileApp(): ProfileApp {
	return getContext<ProfileApp>(KEY);
}
