import { getContext, setContext } from 'svelte';
import type { CapabilityCause } from '../crypto/capability';
import type { ProfileStore } from './store.svelte';
import type { TimelineStateStore } from '../timeline';
import type { CalendarSyncStore } from '../calendar/store.svelte';
import type { ByokStore } from '../ask/byok/store';
import type { Relockable } from './app-init';
import type { BusSignal } from '../broadcast/bus';

// `damaged`: the saved data failed its own checks at start-up, so only the erase is offered (see `isDamagedRecord`).
export type AppStatus = 'loading' | 'ready' | 'unsupported' | 'stale' | 'error' | 'damaged';

/**
 * The status a failed start-up leaves. Only a start-up still loading takes the failure: a takeover set while it ran
 * (another tab upgraded the database and closed this connection, so the next read threw) already names the cause.
 */
export function afterStartupFailure(current: AppStatus, next: AppStatus): AppStatus {
	return current === 'loading' ? next : current;
}

/**
 * The status a finished start-up leaves. A start-up still loading takes it, and so does one that outlasted its timeout
 * or was blocked (`error`): a start-up that ends late opens the app, so a slow or blocked open recovers without a
 * Reload. A takeover (`stale`, `unsupported`) names a cause no result can undo.
 */
export function afterStartupResult(
	current: AppStatus,
	next: 'ready' | 'damaged' | 'unsupported'
): AppStatus {
	return current === 'loading' || current === 'error' ? next : current;
}

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
	byok: ByokStore | null;
	cause: CapabilityCause | null;
	/**
	 * Erase every store on the device. An app-level act, not a store-level one: it must clear stores
	 * by registry name, because a store that failed to provision is exactly the one whose rows would
	 * outlive the wipe and then block their own recovery. Null until app-init resolves.
	 */
	wipeAll: (() => Promise<void>) | null;
	/**
	 * Relock every provisioned store. Use this for ANY "lock" or "erase" - never relock stores
	 * one by one at a call site: a per-site list drifts, and decrypted PII is left behind silently.
	 * Null until app-init resolves ready or damaged; under `damaged` it relocks only a running backup Check (nothing
	 * else is decrypted there; the erase's check relocks its own store).
	 */
	relockAll: (() => void) | null;
	/**
	 * Joins a relockable to the app's relock list for as long as it lives; the function it returns leaves the list.
	 * Null until app-init resolves ready or damaged.
	 */
	joinRelock: ((r: Relockable) => () => void) | null;
	/**
	 * Broadcasts a signal to the other tabs through the relock echo, so a relock it causes stays local to the peer.
	 * Null until app-init resolves ready, and under `damaged`.
	 */
	publish: ((s: BusSignal) => void) | null;
	/**
	 * Set when this device's data was replaced from a backup, in this tab or another, while this tab was locked: the
	 * next Unlock reloads the page instead of re-reading. False until then.
	 */
	reloadOnUnlock: boolean;
	/**
	 * Set when a first-run tab that is locked learns its data was replaced by another tab; the layout then shows a
	 * Reload line. False until then.
	 */
	replacedNotice: boolean;
};

const KEY = Symbol('mtc-profile-app');

export function setProfileApp(app: ProfileApp): void {
	setContext(KEY, app);
}

export function getProfileApp(): ProfileApp {
	return getContext<ProfileApp>(KEY);
}
