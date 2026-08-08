/**
 * Memoize a one-shot async load. Concurrent callers share a single in-flight promise, and a resolved
 * value is reused for the life of the caller (in the Worker, the isolate). A REJECTION is NOT cached: the
 * memo clears so the next call retries, rather than every later request inheriting a transient failure
 * (e.g. a KV blip) until the isolate recycles.
 *
 * Args:
 *   load: the underlying loader, run at most once per successful cache fill.
 *
 * Returns:
 *   a zero-arg function returning the shared/cached promise.
 */
export function createCachedLoader<T>(load: () => Promise<T>): () => Promise<T> {
	let promise: Promise<T> | null = null;
	return () => {
		if (promise === null) {
			const p = load();
			// Clear the memo on failure so a later call retries, guarding against a race where a newer
			// load has already replaced it.
			p.catch(() => {
				if (promise === p) promise = null;
			});
			promise = p;
		}
		return promise;
	};
}
