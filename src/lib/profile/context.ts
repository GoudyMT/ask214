import { getContext, setContext } from 'svelte';
import type { CapabilityCause } from '../crypto/capability';
import type { ProfileStore } from './store.svelte';
import type { TimelineStateStore } from '../timeline/state.svelte';
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
	 * The open database: the same connection the stores use, and the only one in the tab. A page that needs the database
	 * (the backup card) uses this one and never opens or closes its own. Null until app-init resolves ready or damaged.
	 */
	db: IDBDatabase | null;
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
	/** The keystore row's mode, read at start-up and again after a key-change signal. Absent reads as `local`. */
	keyMode?: 'local' | 'pin';
	/**
	 * True while the keystore is in PIN mode and this tab holds no session. The routes show the PIN Unlock card then;
	 * the unlock sets a session and calls `unlockStores`.
	 */
	pinLocked?: boolean;
	/**
	 * After the caller has set a session: loads every store (profile, timeline, calendar) as a user unlock does, then
	 * clears `pinLocked`. The profile must load: if it cannot, every key and every plaintext is dropped and the call
	 * rejects, so a retry is a fresh unlock; a timeline or calendar that cannot be read never blocks. Absent until app-init
	 * resolves ready.
	 */
	unlockStores?: (() => Promise<void>) | null;
	/**
	 * Opens the damaged screen from a ready tab: drops the plaintext, sets the status to `damaged`, and makes the erase
	 * check first, through `check`, that the data is still damaged. The erase relocks before it checks, so `check` holds no
	 * key, session or counter: it compares the stored bytes with the ones that failed (`checkStoredBytes`) and rejects only
	 * while they are unchanged; any change means another tab wrote, and nothing is erased. Absent until app-init resolves
	 * ready.
	 */
	enterDamaged?: (check: () => Promise<unknown>) => void;
};

const KEY = Symbol('mtc-profile-app');

export function setProfileApp(app: ProfileApp): void {
	setContext(KEY, app);
}

export function getProfileApp(): ProfileApp {
	return getContext<ProfileApp>(KEY);
}
