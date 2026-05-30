import { KeystoreAlreadyExistsError } from '../keystore/bootstrap';
import type { CapabilityResult, CapabilityCause } from '../crypto/capability';

/**
 * App-init orchestration for the profile subsystem. Pure + dependency-injected so the
 * unsupported / first-run / returning-user / hard-error paths are unit-testable without a
 * browser. The +layout (Milestone L2b) supplies the real deps and wires the returned store
 * + bus into Svelte context; this module owns only the sequence + the first-run idempotency.
 *
 * Sequence: capability gate (fail-closed) -> open IDB -> ensure keystore bootstrapped
 * (bootstrap throws KeystoreAlreadyExistsError on a returning user - the expected "already
 * set up" signal, not an error) -> create the store -> initial load.
 *
 * Source: Phase 2 spec section 6 (fail-closed bootstrap) + ADR-009 v1.0 scope.
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
