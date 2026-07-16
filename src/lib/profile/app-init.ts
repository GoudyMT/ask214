import { KeystoreAlreadyExistsError } from '../keystore/bootstrap';
import type { CapabilityResult, CapabilityCause } from '../crypto/capability';
import type { ProfileBus, BusSignal } from '../broadcast/bus';
import type { IdleTimer, IdleTimerOptions } from './idle-timer';

/**
 * App-init orchestration for the profile subsystem. Pure + dependency-injected so the
 * unsupported / first-run / returning-user / hard-error paths are unit-testable without a
 * browser. The +layout supplies the real deps and wires the returned store
 * + bus into Svelte context; this module owns only the sequence + the first-run idempotency.
 *
 * Sequence: capability gate (fail-closed) -> open IDB -> ensure keystore bootstrapped
 * (bootstrap throws KeystoreAlreadyExistsError on a returning user - the expected "already
 * set up" signal, not an error) -> create the store -> initial load.
 */

/** Minimal structural contract this module needs from the store. */
type LoadableStore = { load: () => Promise<unknown> };

export type AppInitDeps<S extends LoadableStore> = {
	checkSupport: () => Promise<CapabilityResult>;
	openDb: () => Promise<IDBDatabase>;
	bootstrap: (db: IDBDatabase) => Promise<unknown>;
	createStore: (db: IDBDatabase) => S;
};

export type AppInitResult<S extends LoadableStore> =
	| { status: 'unsupported'; cause: CapabilityCause }
	| { status: 'ready'; store: S; db: IDBDatabase };

export async function initProfileApp<S extends LoadableStore>(
	deps: AppInitDeps<S>
): Promise<AppInitResult<S>> {
	const support = await deps.checkSupport();
	if (!support.ok) return { status: 'unsupported', cause: support.cause };

	const db = await deps.openDb();

	// First-run idempotency: bootstrap throws KeystoreAlreadyExistsError for a returning
	// user. That is the expected "already set up" signal - swallow it; rethrow anything else.
	try {
		await deps.bootstrap(db);
	} catch (e) {
		if (!(e instanceof KeystoreAlreadyExistsError)) throw e;
	}

	const store = deps.createStore(db);
	await store.load();
	return { status: 'ready', store, db };
}

/**
 * Provision a secondary store on the already-open db: create it, then run the initial load.
 * Mirrors initProfileApp's create-then-load tail, kept separate so a store can ride on the same
 * db without coupling into initProfileApp's single-store generic. The +layout calls this after
 * the profile app is ready (for the timeline + calendar stores), passing the db that init returns.
 */
export async function provisionStore<S extends LoadableStore>(
	db: IDBDatabase,
	makeStore: (db: IDBDatabase) => S
): Promise<S> {
	const store = makeStore(db);
	await store.load();
	return store;
}

/**
 * Guards the cross-tab relock signal against self-amplification.
 *
 * Every store signals `relocked` when it relocks, and every tab relocks EVERY store when it hears
 * one. So a tab that answers a peer by re-signalling multiplies the traffic by (stores x tabs) on
 * each hop - one `pagehide` with 3 stores and 2 tabs goes 3 -> 9 -> 27 until the channel saturates
 * and both tabs wedge. Nothing needs the answer: the originator's signal already reached every tab.
 *
 * `publish` is the seam every store broadcasts through; `answer` marks the peer-driven relock so the
 * signals it raises stay local. Provenance is why this lives here and not in the stores - a store
 * cannot know WHY it is being relocked, only the wiring can.
 */
export function createRelockEcho(bus: ProfileBus): {
	publish: (signal: BusSignal) => void;
	answer: (relockAll: () => void) => void;
} {
	let answering = false;
	return {
		publish(signal: BusSignal): void {
			if (answering && signal.type === 'relocked') return;
			bus.publish(signal);
		},
		answer(relockAll: () => void): void {
			answering = true;
			try {
				relockAll();
			} finally {
				// finally, not a trailing assignment: one store throwing mid-relock must not wedge the
				// seam shut for the rest of the tab's life.
				answering = false;
			}
		}
	};
}

/**
 * Guards the cross-tab re-read against un-relocking a locked tab.
 *
 * A `*-updated` signal means a peer changed the record, so re-read it. But an unconditional re-read
 * DECRYPTS: a peer tab's ordinary save would pull a locked tab's profile and task notes back into
 * memory and onto the screen, silently undoing the lock. Worse, the idle timer that locked it has
 * already fired and is not rescheduled, so the tab stays unlocked indefinitely.
 *
 * A locked tab loses nothing by staying locked - every unlock path re-reads all stores, so it picks
 * up the peer's change the moment the user actually asks for it.
 */
export function createPeerReload(isLocked: () => boolean) {
	return (load: () => Promise<unknown> | undefined): void => {
		if (isLocked()) return;
		void load();
	};
}

/**
 * Wire a cross-tab bus to a handler map: each incoming signal invokes `handlers[signal.type]`
 * if present. The +layout maps `relocked` to relock-all and each `*-updated` to that store's
 * load (load is itself fail-closed + verified, so a spoofed same-origin signal can at worst
 * trigger a harmless re-read). Returns the unsubscribe fn for teardown. Bus-abstracted so it is
 * testable with a real BroadcastChannel pair.
 */
export function subscribeBus(
	bus: ProfileBus,
	handlers: Partial<Record<BusSignal['type'], () => void>>
): () => void {
	return bus.subscribe((signal) => {
		handlers[signal.type]?.();
	});
}

/** User-input events that reset the idle countdown. Passive listeners (no scroll-jank). */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'pointermove', 'scroll', 'touchstart'] as const;

/**
 * A store the app can relock + reload across the page lifecycle and cross-tab signals. `lock`
 * is optional: the profile store exposes an async lock(); the timeline store relocks
 * synchronously (drop-reference) and omits it.
 */
export type Relockable = {
	relockSync: () => void;
	load: () => Promise<unknown>;
	lock?: () => Promise<void>;
};

/**
 * Relock EVERY store in one pass - the single definition of "relock everything".
 *
 * The idle timer, the Settings Lock button, and the erase all walk this one list. Two of those used
 * to enumerate their own set, and both enumerated only the profile: the timeline's decrypted
 * free-text task notes stayed resident in memory through a lock and through an erase. A relock set
 * that lives in more than one place drifts, and the drift is invisible because nothing fails.
 *
 * The profile defers via lock() so an in-flight encrypt/write is never interrupted; stores without
 * one drop their reference synchronously. Each store is isolated: one throwing must not strand PII
 * in every store after it in the list.
 *
 * NOT for the cross-tab bus handler - that path must stay fully synchronous inside the relock echo's
 * answer() frame, so it calls relockSync directly.
 */
export function relockAll(relockables: Relockable[]): void {
	for (const r of relockables) {
		try {
			if (r.lock) void r.lock();
			else r.relockSync();
		} catch {
			/* isolated: the next store's PII still gets zeroized */
		}
	}
}

/** Injected so the whole path is unit-testable; +layout supplies window, document, the real
 * createIdleTimer, and the 15-minute threshold. */
type ProfileLifecycleDeps = {
	win: EventTarget;
	doc: EventTarget;
	createIdleTimer: (opts: IdleTimerOptions) => IdleTimer;
	idleThresholdMs: number;
};

/**
 * Wire Page-Lifecycle + idle relock behavior onto the injected event targets, for EVERY
 * relockable store. `pagehide` (window) and `freeze` (document) relock each store - zeroize
 * PII - when the page is backgrounded or frozen; a persisted `pageshow` (BFCache restore)
 * re-reads each from IDB; user input resets an idle timer that, on idle, locks stores exposing
 * lock() and relock-syncs the rest. All stores relock together (atomic). Returns a teardown
 * that stops the timer and removes every listener.
 */
export function installLifecycle(
	relockables: Relockable[],
	deps: ProfileLifecycleDeps
): () => void {
	const idle = deps.createIdleTimer({
		thresholdMs: deps.idleThresholdMs,
		onIdle: () => relockAll(relockables)
	});

	const onHide = (): void => {
		for (const r of relockables) r.relockSync();
	};
	const onShow = (e: Event): void => {
		if ((e as PageTransitionEvent).persisted) {
			for (const r of relockables) void r.load();
		}
	};
	const onActivity = (): void => idle.recordActivity();

	deps.win.addEventListener('pagehide', onHide);
	deps.doc.addEventListener('freeze', onHide);
	deps.win.addEventListener('pageshow', onShow);
	for (const ev of ACTIVITY_EVENTS) {
		deps.win.addEventListener(ev, onActivity, { passive: true });
	}
	idle.start();

	return () => {
		idle.stop();
		deps.win.removeEventListener('pagehide', onHide);
		deps.doc.removeEventListener('freeze', onHide);
		deps.win.removeEventListener('pageshow', onShow);
		for (const ev of ACTIVITY_EVENTS) {
			deps.win.removeEventListener(ev, onActivity);
		}
	};
}
