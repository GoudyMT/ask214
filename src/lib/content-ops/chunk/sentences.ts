// Minimal abbreviation guard: a period after one of these (case-insensitive, trailing dot stripped) is NOT a
// sentence end. Kept small on purpose - a missed split only shifts a chunk boundary, never breaks coverage.
const ABBREV = new Set([
	'u.s',
	'u.s.c',
	'no',
	'inc',
	'corp',
	'co',
	'etc',
	'vs',
	'dr',
	'mr',
	'mrs',
	'ms',
	'jr',
	'sr',
	'st',
	'dept',
	'fig'
]);

/**
 * Split `text` into contiguous, tiling sentence spans (offsets into `text`). A boundary falls after
 * sentence-final punctuation + optional closing quote/bracket + whitespace when the next char starts a new
 * sentence (capital or digit) and the preceding word is not a known abbreviation. Spans tile `[0, len)` so a
 * caller can pack them without dropping characters. Pure, ASCII-only.
 */
export function splitSentences(text: string): Array<{ start: number; end: number }> {
	const bounds: number[] = [0];
	const re = /[.!?]+["')\]]*\s+(?=[A-Z0-9])/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const beforeDot = text.slice(0, m.index + 1);
		const wordMatch = /(\S+)$/.exec(beforeDot);
		const word = (wordMatch?.[1] ?? '').toLowerCase().replace(/[.!?]+$/, '');
		if (ABBREV.has(word)) continue;
		bounds.push(m.index + m[0].length);
	}
	bounds.push(text.length);

	const spans: Array<{ start: number; end: number }> = [];
	for (let i = 0; i < bounds.length - 1; i++) {
		const start = bounds[i] ?? 0;
		const end = bounds[i + 1] ?? text.length;
		if (end > start || spans.length === 0) spans.push({ start, end });
	}
	return spans;
}
