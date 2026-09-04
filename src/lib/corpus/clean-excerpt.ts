// Runtime display-text cleaner for corpus excerpts. The corpus embeds the RAW extracted text so the
// retrieval ranking stays exactly at its measured floor (editing the embedded text perturbs the
// rankings - measured), and this normalizes the residual extraction artifacts the user actually SEES
// on a result card, in eight passes: font-encoding garbage (Private-Use-Area remnants and C0/C1 control
// runs a decorative glyph row extracts as), the running publication footer some appendix/front pages
// fuse onto a chunk, the pipe-delimited running page header, the "Module N:" running header, the
// front-matter page token, worksheet blank rules, inline list-marker glyphs, and the sub-bullets that
// extraction reduced to a bare letter. Pure + browser-safe, shared by the result cards, the offline
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

// A second running-header form: `tap_va_benefits_guide` prints "Module 6: Course Capstone" on every
// page, and extraction fuses it into the body at a page break as well as at a chunk start, so this
// cannot anchor to the opening the way the front-matter rule below does. 136 occurrences.
//
// THREE things carry the safety here, each measured over all 1878 chunks:
//
// 1. The COLON is mandatory. The corpus has 92 prose references of the form "Module N" with no colon
//    ("Upon completion of Module 1, you will be able to:", "Lunch occurs after Module 3,"). Relaxing
//    the colon destroys every one of them.
// 2. The match is CASE-SENSITIVE. Upper-case "MODULE 1:" is the guide's title page, not its running
//    header, and it carries a DIFFERENT title ("MODULE 1: Introduction to VA Benefits and Services" -
//    note the "VA"). Two occurrences; stripping them would delete real title-page content.
// 3. The titles are sorted LONGEST FIRST. JS alternation is leftmost-alternative-wins, so a title that
//    is a strict PREFIX of another real title would match first and leave the remainder fused into the
//    prose after it - which is how an earlier draft of this rule turned "Module 5: Finding a Place to
//    Live and Community Resources" into a dangling "and Community Resources" across 17 chunks. Sorting
//    is done here rather than by hand so a title added later cannot reintroduce that.
//
// A guide whose title is NOT listed keeps its header visible rather than losing text: the five
// `tap_va_womens_health` "Module N:" lines use a different title set and are a contents listing, not a
// running header, so they are deliberately left alone.
const MODULE_TITLES = [
	'Introduction to Benefits and Services',
	'Maintaining Your Health',
	'Applying for Disability Compensation',
	'Getting Career Ready',
	'Finding a Place to Live and Community Resources',
	'Course Capstone'
]
	.slice()
	.sort((a, b) => b.length - a.length)
	.join('|');
const MODULE_HEADER_RE = new RegExp('\\s*Module \\d+:\\s*(?:' + MODULE_TITLES + ')', 'g');

// The front-matter page token the online resource guides print above the title, which extraction fuses
// onto the body either glued to the title ("page 1Mental Health for Families") or standing alone at the
// opening ("page 1 Other Than Honorable"). 29 occurrences: 25 open a chunk, and 4 sit mid-text where a
// page break fused one in, so the glued alternative is deliberately NOT anchored to the string start.
//
// Only the PAGE TOKEN is removed. The words after it are not touched: "Resource Guide" is the name of a
// real document these guides cite constantly in prose ("The VETS Resource Guide (PDF) contains links...",
// "This Online Resource Guide provides you with the web links..."). It occurs 78 times across 62 chunks,
// the majority in ordinary sentences, so a rule anchored on the NAME rather than the token would delete
// them. The lookahead is what keeps the unanchored alternative safe: it requires a capital immediately
// after the digits with no space, which is an extraction artifact, so a prose "on page 5 of the handbook"
// or "see page 60 to get started" is never touched.
const FRONT_MATTER_PAGE_RE = /(?:^|\s)page ?\d+(?=[A-Z])|^\s*page\s+\d+\s+/g;

// Worksheet fill-in-the-blank rules ("My current job is ______") extract as underscore runs that
// carry no content and read as corruption on a card. Three or more, so an identifier like source_id
// is left alone.
const BLANK_RULE_RE = /_{3,}/g;

// Symbol/Wingdings sub-bullets the extractor reduced to a bare letter, which separate list items the
// same way the glyph markers above do. 158 standalone lowercase "y"/"o" exist in the corpus: 141 are
// bullets, and 17 are NOT.
//
// Three separate classes of single letter have to survive, so the match is narrow on purpose:
//   - Multiple-choice answer options ("...Facilities d Community Living Centers e All of these") - a
//     different letter set, excluded by matching only y and o.
//   - An initial in a name - excluded by matching lower case only.
//   - LETTER-SPACED text. Three chunks in tap_va_benefits_guide carry the Whole Health diagram labels,
//     which extraction flattened so that every letter is its own token: "C o m m u n i t y P r e v e n
//     t i o n". A bare y/o rule fires INSIDE those words and turns "Community" into "C - m m u n i t -".
//     The neighbour constraint below is what excludes them: a real bullet always sits between
//     multi-character tokens, a tracked-out letter never does.
//
// The cost is 8 bullets the constraint declines to convert (a bullet whose neighbour is itself one
// character). That direction is the safe one: an unconverted bullet leaves a stray letter exactly as it
// renders today, whereas a converted letter destroys a word.
const LETTER_BULLET_RE = /(?:(?<=[^\s]{2}\s)|(?<=^)|(?<=^\s))\b[yo]\b(?=\s+[A-Za-z0-9]{2})/g;

const WHITESPACE_RE = /\s+/g;
// A separator left stranded at either end (from a leading or trailing marker) is not content.
const EDGE_SEPARATOR_RE = /^(?:- )+|(?: -)+$/g;

/**
 * Normalizes the residual extraction artifacts in a corpus excerpt for display: strips font-encoding
 * garbage, the fused publication footer and the running page headers, and converts inline list markers
 * to " - " separators. See the DISPLAY-ONLY CONTRACT above - this is not the anchor-space normalizer.
 *
 * Args:
 *     text: The raw corpus chunk text (or a stored excerpt) to clean for display.
 *
 * Returns:
 *     The display-clean text, in pipeline order: font-encoding garbage removed, the publication footer
 *     stripped, the pipe-delimited and "Module N:" running headers stripped, the front-matter page token
 *     removed, worksheet blank rules removed, marker-glyph runs and bare-letter sub-bullets converted to
 *     " - ", whitespace collapsed, and any stranded edge separator trimmed. Clean prose is unchanged.
 */
export function cleanExcerpt(text: string): string {
	let s = text.replace(GARBAGE_RE, '');
	s = s.replace(VERSION_FOOTER_RE, ' ');
	s = s.replace(RUNNING_HEADER_RE, ' ');
	s = s.replace(MODULE_HEADER_RE, ' ');
	s = s.replace(FRONT_MATTER_PAGE_RE, ' ');
	s = s.replace(BLANK_RULE_RE, ' ');
	s = s.replace(MARKER_RUN_RE, ' - ');
	s = s.replace(LETTER_BULLET_RE, ' - ');
	s = s.replace(WHITESPACE_RE, ' ').trim();
	s = s.replace(EDGE_SEPARATOR_RE, '').trim();
	return s;
}
