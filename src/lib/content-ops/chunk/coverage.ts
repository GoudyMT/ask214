import type { ChunkSpan } from './split';

export type CoverageResult = { ok: true } | { ok: false; reason: 'gap' | 'overlap'; at: number };

/**
 * Lossless coverage: assert the chunk spans cover every NON-whitespace character of `normalizedText`
 * exactly once. Boundaries may fall only on collapsed whitespace (the single-space gaps between chunks). A
 * dropped non-whitespace run -> `gap`; a backwards/overlapping span -> `overlap`. Pure.
 */
export function checkCoverage(spans: ChunkSpan[], normalizedText: string): CoverageResult {
	const sorted = [...spans].sort((a, b) => a.startOffset - b.startOffset);
	let cursor = 0;
	for (const s of sorted) {
		if (s.startOffset < cursor) return { ok: false, reason: 'overlap', at: s.startOffset };
		if (/\S/.test(normalizedText.slice(cursor, s.startOffset)))
			return { ok: false, reason: 'gap', at: cursor };
		cursor = s.endOffset;
	}
	if (/\S/.test(normalizedText.slice(cursor))) return { ok: false, reason: 'gap', at: cursor };
	return { ok: true };
}
