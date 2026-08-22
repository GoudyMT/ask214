/**
 * Requests durable storage so the browser will not evict the app's IndexedDB.
 *
 * Load-bearing on iOS: the AES-GCM data key is stored non-extractable inside the same IndexedDB as
 * the ciphertext, so evicting that database is unrecoverable loss. WebKit grants persistent storage
 * to installed (Home Screen) web apps, which moves the origin out of the eviction path.
 *
 * Best-effort by construction: rather than feature-detecting (a present API can still be
 * non-functional), it exercises persisted()/persist() and catches, so every absent or failing path
 * degrades to a quiet outcome and this can run inside app-init without ever throwing. An
 * already-persistent origin is left alone instead of re-requesting.
 */

export type PersistenceOutcome = 'granted' | 'already' | 'denied' | 'unsupported';

/** The StorageManager touch-points, injected so the decision is unit-testable without a browser. */
export type PersistenceOps = {
	persisted: () => Promise<boolean>;
	persist: () => Promise<boolean>;
};

export const realPersistenceOps: PersistenceOps = {
	persisted: () => navigator.storage.persisted(),
	persist: () => navigator.storage.persist()
};

export async function requestPersistentStorage(
	ops: PersistenceOps = realPersistenceOps
): Promise<PersistenceOutcome> {
	try {
		if (await ops.persisted()) return 'already';
		return (await ops.persist()) ? 'granted' : 'denied';
	} catch {
		return 'unsupported';
	}
}
