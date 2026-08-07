import type { RetrievalResult, ResultCard } from './types';
import { cleanExcerpt } from './clean-excerpt';

/**
 * Map retrieval hits to citation-complete card view-models the Ask UI renders. The excerpt is
 * `chunk.excerpt ?? chunk.text` run through cleanExcerpt, which normalizes the residual extraction
 * artifacts a user sees (inline bullet glyphs, font garbage, a fused version footer) WITHOUT touching
 * the embedded corpus text - retrieval ranks on the raw text, display shows the cleaned text. No
 * truncation/word-count here (that display shaping is the Ask UI's job). Optional page/section are
 * conditionally spread so a missing value never becomes an `undefined` key (exactOptionalPropertyTypes).
 * Every card carries its full citation - citations can never be dropped.
 */
export function toResultCards(results: RetrievalResult[]): ResultCard[] {
	return results.map(({ chunk, score }) => ({
		sourceId: chunk.sourceId,
		sourceTitle: chunk.sourceTitle,
		...(chunk.page !== undefined ? { page: chunk.page } : {}),
		...(chunk.section !== undefined ? { section: chunk.section } : {}),
		excerpt: cleanExcerpt(chunk.excerpt ?? chunk.text),
		url: chunk.url,
		score
	}));
}
