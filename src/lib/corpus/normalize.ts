/**
 * The single canonical text normalizer. Anchors + chunk ids are computed in NORMALIZED space,
 * and the future highlight viewer MUST apply this same function before searching - so a text-quote anchor
 * resolves deterministically across the extracted-text / PDF.js-text-layer / app-rendered-HTML surfaces.
 * The job is DETERMINISM (same input -> same output, applied identically on both the stored anchor and
 * the viewer's search target), NOT linguistic perfection - so even heuristic de-hyphenation still resolves
 * consistently. Shared by the pipeline (build) and the future viewer (runtime); pure, no IO, no third-party
 * deps. Regexes + ligature keys are built from code points so the source file stays pure ASCII.
 */

// Latin typographic ligatures (Unicode Alphabetic Presentation Forms U+FB00..U+FB06) -> ASCII expansions.
const LIGATURES: Record<string, string> = {
	[String.fromCodePoint(0xfb00)]: 'ff',
	[String.fromCodePoint(0xfb01)]: 'fi',
	[String.fromCodePoint(0xfb02)]: 'fl',
	[String.fromCodePoint(0xfb03)]: 'ffi',
	[String.fromCodePoint(0xfb04)]: 'ffl',
	[String.fromCodePoint(0xfb05)]: 'st',
	[String.fromCodePoint(0xfb06)]: 'st'
};

const LIGATURE_RE = new RegExp('[\\uFB00-\\uFB06]', 'g');
// zero-width space / non-joiner / joiner, BOM (zero-width no-break space), and soft hyphen. Built as an
// alternation, not a [class]: putting the zero-width joiner in a class trips no-misleading-character-class.
const ZERO_WIDTH_RE = new RegExp('\\u200B|\\u200C|\\u200D|\\uFEFF|\\u00AD', 'g');
// a hyphen at a line break (optional surrounding spaces/tabs; CRLF or LF) joins the split word.
const DEHYPHEN_RE = new RegExp('-[ \\t]*\\r?\\n[ \\t]*', 'g');
// any run of whitespace (\s already covers NBSP + BOM) collapses to a single space.
const WHITESPACE_RE = new RegExp('\\s+', 'g');

export function normalizeText(input: string): string {
	let s = input.normalize('NFC');
	s = s.replace(LIGATURE_RE, (ch) => LIGATURES[ch] ?? ch);
	s = s.replace(ZERO_WIDTH_RE, '');
	s = s.replace(DEHYPHEN_RE, '');
	s = s.replace(WHITESPACE_RE, ' ');
	return s.trim();
}
