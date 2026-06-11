import type { RetrievalResult, ResultCard } from './types';

/**
 * Map retrieval hits to citation-complete card view-models the Ask UI (C) renders. Pure pass-through:
 * excerpt is `chunk.excerpt ?? chunk.text` - NO truncation, sentence handling, or word-count here
 * (all display shaping is C's job; this keeps a lossy 200-word decision out of the core). Optional
 * page/section are conditionally spread so a missing value never becomes an `undefined` key
 * (exactOptionalPropertyTypes). Every card carries its full citation - citations can never be dropped.
 */
export function toResultCards(results: RetrievalResult[]): ResultCard[] {
	return results.map(({ chunk, score }) => ({
		sourceId: chunk.sourceId,
		sourceTitle: chunk.sourceTitle,
		...(chunk.page !== undefined ? { page: chunk.page } : {}),
		...(chunk.section !== undefined ? { section: chunk.section } : {}),
		excerpt: chunk.excerpt ?? chunk.text,
		url: chunk.url,
		score
	}));
}
