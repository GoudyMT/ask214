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
 * Provision the timeline-state store: create it from the already-open db and run the initial
 * load. Mirrors initProfileApp's create-then-load tail, kept separate so the timeline store
 * rides on the same db without coupling into initProfileApp's single-store generic. The
 * +layout calls this after the profile app is ready, passing the db that init returns.
 */
export async function provisionTimelineStore<S extends LoadableStore>(
	db: IDBDatabase,
	makeStore: (db: IDBDatabase) => S
): Promise<S> {
	const store = makeStore(db);
	await store.load();
	return store;
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
		onIdle: () => {
			for (const r of relockables) {
				if (r.lock) void r.lock();
				else r.relockSync();
			}
		}
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
