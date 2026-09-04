// Runtime display-text cleaner for corpus excerpts. The corpus embeds the RAW extracted text so the
// retrieval ranking stays exactly at its measured floor (editing the embedded text perturbs the
// rankings - measured), and this normalizes the residual extraction artifacts the user actually SEES
// on a result card: inline list-marker glyphs, font-encoding garbage (Private-Use-Area remnants and
// C0/C1 control runs a decorative glyph row extracts as), and the running publication footer some
// appendix/front pages fuse onto a chunk. Pure + browser-safe, shared by the result cards, the offline
// source reader, and the online synthesis path (so the model reads clean text too). Glyph sets are
// built from \u escapes / code points so this source file stays pure ASCII.
//
// DISPLAY-ONLY CONTRACT: this is a LOSSY readability transform for text the user SEES. It is NOT the
// canonical text normalizer. Never call cleanExcerpt in the anchor / chunk-id / highlight / find-in-source
// path - that path MUST use normalizeText (./normalize), whose job is DETERMINISM (same input -> same
// output on both the stored anchor and the viewer's search target), not readability. cleanExcerpt deletes
// footers and glyphs and so would break anchor resolution; the two transforms are distinct by design and a
// test asserts they diverge.

// List-marker / separator glyphs seen in this corpus: bullet, black/white square, diamond, circles, small
// square, bullet operator; the right guillemet used as a breadcrumb separator ("module <bb> VA Benefits");
// dingbat negative-circled digits used as ordered-list bullets ("PROGRAM <277a> VA Housing"); and the
// minus sign U+2212, which this corpus uses ONLY as a bullet/separator (measured: 20/20 sampled were
// list/contact separators like "Excel, Outlook <2212> work independently", never a math minus). A
// whitespace-bounded run of them collapses to one " - " separator. (Escapes, not fromCodePoint, so the
// U+2776-U+277F range reads plainly and the source stays ASCII.)
const MARKER_CLASS =
	'\\u2022\\u25a0\\u25a1\\u2666\\u25cb\\u25aa\\u25cf\\u2219\\u00bb\\u2212\\u2776-\\u277f';
const MARKER_RUN_RE = new RegExp('\\s*(?:[' + MARKER_CLASS + ']\\s*)+', 'g');

// Font-encoding garbage, deleted - it marks nothing: C0 controls (a decorative glyph strip the extractor
// dropped to control codes) except tab/LF/CR which whitespace handles, DEL + C1 controls, the Private Use
// Area (Symbol/Wingdings remnants), the Unicode replacement char, and the one broken supplementary-plane
// glyph this corpus carries (U+110BB, a surrogate pair).
const GARBAGE_RE = new RegExp(
	// Matching control characters is the intent here - these ranges ARE the extraction garbage we delete.
	// eslint-disable-next-line no-control-regex
	'[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\ue000-\\uf8ff\\ufffd]|\\ud804\\udcbb',
	'g'
);

// A running publication footer PDF extraction fuses onto a chunk, in two forms. Anchored on a FULL month
// name + 4-digit year so a bare "Revised 2021" citation or an "in May 2025" prose date is never eaten:
//   Version-anchored: [pageToken]Version <n[.n[.n]]> ([Released|Revised] <Month> <Year>)+ [for release ...<Year>]
//     the page token is a letter-hyphen appendix ref "A-160", a roman numeral "viii", or a bare page number,
//     glued to the front; the version reads "6 1" (space) or "6.1" / "3.0.1" (dot); the date clauses chain
//     ("Released March 2024, Revised July 2025") and an optional "for release <Month> <Year>" tail closes it.
//   bare Revised tail: ", Revised|Released <Month> <Year>" - a running guide-title header footer with no
//     Version token ("...Online Resource Guide , Revised May 2025").
const MONTHS =
	'(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const PAGE_TOKEN = '(?:[A-Z]-\\d{1,3}|[ivxlcdm]{2,7}|\\d{1,3})?';
const VERSION_NUM = 'Version \\d+(?:[. ]\\d+)*';
const DATE_CLAUSE = '(?: +(?:Released|Revised))? +' + MONTHS + ' \\d{4}';
const FOR_RELEASE = '(?: +for release .{0,12}?\\d{4})?';
const VERSION_FORM =
	PAGE_TOKEN + VERSION_NUM + DATE_CLAUSE + '(?:,?' + DATE_CLAUSE + ')*' + FOR_RELEASE;
const BARE_REVISED = ' *,\\s*(?:Released|Revised) +' + MONTHS + ' \\d{4}';
const VERSION_FOOTER_RE = new RegExp('(?:' + VERSION_FORM + '|' + BARE_REVISED + ')', 'g');

// A pipe-delimited running page header the guides print on every page, which extraction fuses into the
// body text. Two forms occur: "EFCT PARTICIPANT GUIDE | SECTION 1 | PAGE 14" and, in the sibling DOL
// guide, the same header without the PAGE keyword ("EMPLOYMENT WORKSHOP | SECTION 1 | 11"); a chunk
// boundary can also cut the title off the front or the number off the end, so both are optional.
// Anchored on the literal SECTION keyword and its number so an ordinary pipe survives.
//
// The title is matched LITERALLY, one alternative per guide. A generic caps-word run cannot work here:
// the two titles are different lengths (three words and two), so any word-count bound that fits the
// longer one leaves a free slot in front of the shorter one, and the run then eats the last token of
// real content ("Expires December 20XX" -> "Expires December 20", "Baltimore, MD" -> "Baltimore,").
// A literal list fails in the safe direction instead: a guide title not listed here leaves its header
// visible rather than destroying the words around it. PAGE ends on a word boundary for the same reason,
// so "PAGEANT" does not lose its head.
const RUNNING_HEADER_RE =
	/\s*(?:EFCT PARTICIPANT GUIDE|EMPLOYMENT WORKSHOP)?\s*\|\s*SECTION\s+\d+\s*\|(?:\s*PAGE\b)?(?:\s*\d+)?/g;

// Worksheet fill-in-the-blank rules ("My current job is ______") extract as underscore runs that
// carry no content and read as corruption on a card. Three or more, so an identifier like source_id
// is left alone.
const BLANK_RULE_RE = /_{3,}/g;

const WHITESPACE_RE = /\s+/g;
// A separator left stranded at either end (from a leading or trailing marker) is not content.
const EDGE_SEPARATOR_RE = /^(?:- )+|(?: -)+$/g;

/**
 * Normalizes the residual extraction artifacts in a corpus excerpt for display: strips font-encoding
 * garbage and the fused publication footer, and converts inline list-marker glyphs to " - " separators.
 * See the DISPLAY-ONLY CONTRACT above - this is not the anchor-space normalizer.
 *
 * Args:
 *     text: The raw corpus chunk text (or a stored excerpt) to clean for display.
 *
 * Returns:
 *     The display-clean text: garbage removed, the footer stripped, marker runs converted to " - ",
 *     whitespace collapsed, and any stranded edge separator trimmed. Clean prose is unchanged.
 */
export function cleanExcerpt(text: string): string {
	let s = text.replace(GARBAGE_RE, '');
	s = s.replace(VERSION_FOOTER_RE, ' ');
	s = s.replace(RUNNING_HEADER_RE, ' ');
	s = s.replace(BLANK_RULE_RE, ' ');
	s = s.replace(MARKER_RUN_RE, ' - ');
	s = s.replace(WHITESPACE_RE, ' ').trim();
	s = s.replace(EDGE_SEPARATOR_RE, '').trim();
	return s;
}
