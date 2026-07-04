import { normalizeText } from '../../corpus/normalize';
import type { CorpusChunk } from '$lib/corpus';

/**
 * A positive eval item: the answer IS in the corpus. `sourceId` + `answerSnippet` is the primary
 * (chunk-resolvable) ground truth; `altSources` are additional sources that ALSO validly answer the query -
 * the corpus has genuine content overlap (a comprehensive guide + a specific page both answer many
 * questions), so a hit = ANY valid source in top-k (standard IR multi-relevant). altSources are credited at
 * SOURCE level only (no snippet).
 */
export type GroundTruthQuery = {
	query: string;
	sourceId: string;
	answerSnippet: string;
	altSources?: string[];
};
/** An adversarial item: the answer is NOT in the corpus; success = the search returns nothing above MIN_SCORE. */
export type HardNegativeQuery = { query: string; expectEmpty: true };
export type EvalQuery = GroundTruthQuery | HardNegativeQuery;

// The snippet is a build-time locator (never shipped), so fold curly quotes to straight before matching -
// VA/DoD source text is quote-heavy and an author-typed straight quote must still find curly source text.
// Curly code points via String.fromCharCode so the source stays pure ASCII (no unicode literals).
const CURLY_SINGLE = new RegExp('[' + String.fromCharCode(0x2018, 0x2019) + ']', 'g');
const CURLY_DOUBLE = new RegExp('[' + String.fromCharCode(0x201c, 0x201d) + ']', 'g');

function foldForMatch(s: string): string {
	return normalizeText(s).replace(CURLY_SINGLE, "'").replace(CURLY_DOUBLE, '"');
}

/**
 * Resolve a snippet-anchored ground-truth item to the ids of the chunks in its source whose text contains
 * the (folded, normalized) snippet. [] means no chunk matched - a build signal to fix the snippet (it may
 * straddle a chunk boundary or be mistyped), NOT a silent pass.
 */
export function resolveExpectedIds(
	item: GroundTruthQuery,
	chunksBySource: Map<string, CorpusChunk[]>
): string[] {
	const needle = foldForMatch(item.answerSnippet);
	const source = chunksBySource.get(item.sourceId) ?? [];
	return source.filter((c) => foldForMatch(c.text).includes(needle)).map((c) => c.id);
}

/** Type guard: an item is a hard-negative iff it declares expectEmpty. */
export function isHardNegative(q: EvalQuery): q is HardNegativeQuery {
	return 'expectEmpty' in q && q.expectEmpty === true;
}
