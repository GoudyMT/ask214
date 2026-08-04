import type { CorpusChunk, RetrievalResult } from '$lib/corpus';
import type { RetrievedChunk } from '../synthesis/synthesize';

// The server sends the full CorpusChunk, but the body arrived as unknown. Validate only the fields the two
// consumers actually read (cards + synthesize) and pass optional display fields through when present; a hit
// missing a load-bearing field is dropped rather than rendered from a half-formed object. `tags` is required
// by CorpusChunk but unused downstream, so it defaults to [] - we never fabricate a displayed value.
function narrowOne(entry: unknown): RetrievalResult | null {
	if (entry === null || typeof entry !== 'object') return null;
	const { score, chunk } = entry as { score?: unknown; chunk?: unknown };
	if (typeof score !== 'number' || chunk === null || typeof chunk !== 'object') return null;
	const c = chunk as Record<string, unknown>;
	const { id, text, sourceId, sourceTitle, url, page, section, excerpt } = c;
	if (
		typeof id !== 'string' ||
		typeof text !== 'string' ||
		typeof sourceId !== 'string' ||
		typeof sourceTitle !== 'string' ||
		typeof url !== 'string'
	) {
		return null;
	}
	const narrowed: CorpusChunk = {
		id,
		text,
		sourceId,
		sourceTitle,
		url,
		tags: [],
		...(typeof page === 'number' ? { page } : {}),
		...(typeof section === 'string' ? { section } : {}),
		...(typeof excerpt === 'string' ? { excerpt } : {})
	};
	return { chunk: narrowed, score };
}

/**
 * Narrow the Worker's `results: unknown[]` into validated retrieval hits, dropping any malformed entry.
 *
 * @param results The untyped server hits.
 * @returns The well-formed hits, ready for `toResultCards` and `toRetrievedChunks`.
 */
export function narrowScored(results: unknown[]): RetrievalResult[] {
	return results.map(narrowOne).filter((r): r is RetrievalResult => r !== null);
}

/**
 * Project retrieval hits to the RetrievedChunk shape synthesize reads (its `title` is the chunk's source title).
 *
 * @param results Narrowed retrieval hits.
 * @returns The chunks synthesize answers from.
 */
export function toRetrievedChunks(results: RetrievalResult[]): RetrievedChunk[] {
	return results.map(({ chunk }) => ({
		id: chunk.id,
		text: chunk.text,
		url: chunk.url,
		title: chunk.sourceTitle
	}));
}
