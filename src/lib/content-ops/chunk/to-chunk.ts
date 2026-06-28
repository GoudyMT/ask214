import { deriveChunkId } from '../../corpus/chunk-id';
import type { CorpusChunk } from '../../corpus/types';
import type { ChunkSpan } from './split';
import type { Anchor } from './anchor';

type SourceEntry = { source_id: string; title: string; url: string; origin: string };

/**
 * Assemble one `CorpusChunk` from a span + its registry entry + its computed anchor. The id is the A1
 * content-derived `deriveChunkId` (async); an intra-source exact-duplicate text is disambiguated by appending
 * `-<n>` using the `seen` counter (first occurrence keeps the bare id). `tags` seeds `[origin lowercased]`;
 * `excerpt` is intentionally omitted (v1.1). Optional fields are set only when present (exactOptionalPropertyTypes).
 */
export async function toChunk(
	span: ChunkSpan,
	anchor: Anchor | null,
	entry: SourceEntry,
	seen: Map<string, number>
): Promise<CorpusChunk> {
	const baseId = await deriveChunkId(entry.source_id, span.text);
	const n = seen.get(baseId) ?? 0;
	seen.set(baseId, n + 1);

	const chunk: CorpusChunk = {
		id: n === 0 ? baseId : `${baseId}-${n}`,
		text: span.text,
		sourceId: entry.source_id,
		sourceTitle: entry.title,
		url: entry.url,
		tags: [entry.origin.toLowerCase()]
	};
	if (span.page !== undefined) chunk.page = span.page;
	if (span.section !== undefined) chunk.section = span.section;
	if (anchor !== null) chunk.anchor = anchor;
	return chunk;
}
