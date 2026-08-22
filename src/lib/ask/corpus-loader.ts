import type { Corpus } from '$lib/corpus';

/**
 * A memoized lazy corpus loader. The corpus is fetched once on first call and reused; `onLoaded` fires
 * on success (the route uses it to build the offline reader's source map). Crucially, a REJECTION is not
 * cached - a transient fetch failure clears the memo so the next call retries, rather than trapping the
 * session on a dead promise. Deps injected for testability.
 */
export function createLazyCorpus(
	load: () => Promise<Corpus>,
	onLoaded: (corpus: Corpus) => void
): () => Promise<Corpus> {
	let promise: Promise<Corpus> | null = null;
	return () => {
		promise ??= load()
			.then((corpus) => {
				onLoaded(corpus);
				return corpus;
			})
			.catch((err) => {
				promise = null; // never cache a rejection (from load OR onLoaded) - a later call re-fetches
				throw err;
			});
		return promise;
	};
}
