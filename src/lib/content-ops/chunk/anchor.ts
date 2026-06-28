import { normalizeText } from '../../corpus/normalize';

export type Anchor = { exact: string; prefix?: string; suffix?: string };

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
 * Compute a W3C TextQuoteSelector for the chunk at `[start, end)` of `normalizedText` (A1 section 6). `exact`
 * is the verbatim slice; if it is not unique, grow `prefix` + `suffix` from the chunk's surrounding text until
 * `prefix + exact + suffix` occurs exactly once, bounded at `bound` chars each side; if still ambiguous,
 * return `null` (the chunk then ships page/section only - never a wrong highlight). Mirrors the build-time
 * resolver, which counts `normalizeText(prefix + exact + suffix)` in the normalized source. Pure.
 */
export function computeAnchor(
	normalizedText: string,
	start: number,
	end: number,
	bound = 64
): Anchor | null {
	// Test uniqueness through normalizeText, exactly as the build-time resolver does: it searches for
	// normalizeText(prefix + exact + suffix), which trims boundary whitespace and collapses runs. A raw-text
	// check can call a window unique when only a bounding space made it so - the resolver then trims that space
	// and the window resolves to two spans (an ambiguous anchor the cross-ref gate rejects). normalizedText is
	// already normalized, so it is the haystack as-is; only the needle is normalized.
	const exact = normalizedText.slice(start, end);
	if (countOccurrences(normalizedText, normalizeText(exact)) === 1) return { exact };

	for (let n = 1; n <= bound; n++) {
		const pStart = Math.max(0, start - n);
		const sEnd = Math.min(normalizedText.length, end + n);
		const prefix = normalizedText.slice(pStart, start);
		const suffix = normalizedText.slice(end, sEnd);
		if (countOccurrences(normalizedText, normalizeText(prefix + exact + suffix)) === 1) {
			const anchor: Anchor = { exact };
			if (prefix.length > 0) anchor.prefix = prefix;
			if (suffix.length > 0) anchor.suffix = suffix;
			return anchor;
		}
		if (pStart === 0 && sEnd === normalizedText.length) break;
	}
	return null;
}
