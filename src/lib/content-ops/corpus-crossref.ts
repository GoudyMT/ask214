import { normalizeText } from '../corpus/normalize';
import type { ValidationError, ValidationResult } from './sources-schema';

type ChunkLike = {
	id: string;
	sourceId: string;
	anchor?: { exact: string; prefix?: string; suffix?: string };
};
type RegistryLike = { source_id: string; legal_tier: string };

const ID_RE = /^[a-z0-9_]+:[0-9a-f]{12}(-\d+)?$/;

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let i = haystack.indexOf(needle);
	while (i !== -1) {
		count++;
		i = haystack.indexOf(needle, i + 1);
	}
	return count;
}

/**
 * Build-time corpus <-> registry cross-reference (A1; CI gate from A3 onward). Pure: takes the built
 * chunks, the parsed registry, and a sourceId -> extracted-text map. Verifies legal-cleanliness (every
 * sourceId resolves to a non-excluded entry), id hygiene (unique + the A1-D6 pattern), and citation
 * integrity (every anchor UNIQUELY resolves as a normalized substring of its source). Structured result.
 */
export function validateCorpusAgainstRegistry(
	chunks: ChunkLike[],
	registry: RegistryLike[],
	extractions: Record<string, string>
): ValidationResult {
	const errors: ValidationError[] = [];
	const byId = new Map<string, RegistryLike>();
	for (const r of registry) byId.set(r.source_id, r);

	const seenIds = new Set<string>();
	for (const c of chunks) {
		const entry = byId.get(c.sourceId);
		if (!entry) errors.push({ code: 'E_XREF_UNKNOWN_SOURCE', sourceId: c.sourceId });
		else if (entry.legal_tier === 'excluded')
			errors.push({ code: 'E_XREF_EXCLUDED_SOURCE', sourceId: c.sourceId });

		if (!ID_RE.test(c.id)) errors.push({ code: 'E_XREF_BAD_ID', sourceId: c.sourceId });
		if (seenIds.has(c.id)) errors.push({ code: 'E_XREF_DUP_ID', sourceId: c.sourceId });
		seenIds.add(c.id);

		if (c.anchor) {
			const source = extractions[c.sourceId];
			const anchorWindow = normalizeText(
				(c.anchor.prefix ?? '') + c.anchor.exact + (c.anchor.suffix ?? '')
			);
			const n = source === undefined ? 0 : countOccurrences(normalizeText(source), anchorWindow);
			if (n === 0) errors.push({ code: 'E_XREF_ANCHOR_UNRESOLVED', sourceId: c.sourceId });
			else if (n > 1) errors.push({ code: 'E_XREF_ANCHOR_AMBIGUOUS', sourceId: c.sourceId });
		}
	}

	return { valid: errors.length === 0, errors };
}
