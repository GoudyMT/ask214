import type { Block } from '$lib/content-ops/extract/pdf-text';

export type BlockKind = 'content' | 'toc' | 'disclaimer' | 'frontmatter';
export type Classification = { kind: BlockKind; confidence: number };

// toc: a contents page reads as a dense run of "Title ... pageNumber" entries. We measure that
// two ways - the fraction of whitespace-split tokens that are themselves a bare 1-3 digit page
// number (a real ToC page is stuffed with these; ordinary prose almost never has one), and the
// count of dotted leaders some guides use to visually connect a title to its page number. Capping
// the digit match at 3 characters is deliberate: it lets "12" or "142" count as a page number
// while a 4-digit calendar year ("2021", "1990") never does, since those show up constantly in
// real prose about service dates and are not page numbers.
const TOC_CONTENTS_MARKER_RE = /table of contents|^contents/i;
const TOC_TOKEN_FRACTION_THRESHOLD = 0.12; // measured: real ToCs run 0.20-0.23; real prose tops out under 0.02
const TOC_MIN_DOTTED_LEADERS = 3; // a handful of repeated leaders is unambiguous; stray ellipses in prose are 1-2
const TOC_SCORE_THRESHOLD = 0.5;
// A multi-page contents section only carries the "Contents" marker on its first page - the
// continuation pages are just as unambiguously a contents page, but the marker-gated path above
// never sees them. Measured across every block in this corpus: the highest dotted-leader count in
// any block that is not part of a confirmed multi-page contents section is 4; the lowest count in
// a confirmed marker-less contents continuation page is 9. The threshold sits at that lower bound
// so it uses the full width of the gap - maximal margin above real prose - while still catching
// every confirmed continuation page. This path fires without requiring the marker at all, so it
// must clear a much higher bar than the marker-gated path to avoid catching an ordinary numbered
// or bulleted list; its floor confidence (0.7) matches the orchestrator's auto-drop cutoff exactly,
// since a block dense enough to clear this bar with no marker support at all is not a borderline
// call.
const TOC_MARKERLESS_MIN_DOTTED_LEADERS = 9;
const TOC_MARKERLESS_BASE_SCORE = 0.7;
// Corroboration for the marker-less path: a real contents continuation pairs each dotted leader with a
// page number ("Title .... 90"), so its page-number-token count tracks its dotted-leader count. A dotted
// fill-in worksheet (blank lines, no page numbers) does not - require the page numbers too, or dotted
// density alone would auto-drop such a worksheet as if it were a table of contents.
const TOC_MARKERLESS_MIN_PAGE_NUMBER_RATIO = 0.5;

// disclaimer: the bare word "disclaimer" is not enough on its own - measured on real data, it
// shows up as an aside inside otherwise-real content (a note about the PDF form itself, an
// external-link caveat opening a resource list) far more often than it marks an actual standalone
// disclaimer block, and firing on it would drop genuine government content. The specific
// endorsement phrase, by contrast, is unique to the standalone DoD/VA disclaimer paragraph in
// every real occurrence measured across this corpus - a block that merely contains an unrelated
// disclaimer sentence never has this exact phrase - so it is the only signal used.
const DISCLAIMER_PHRASE_RE = /does not constitute a formal endorsement/i;
const DISCLAIMER_SCORE_THRESHOLD = 0.5;
const DISCLAIMER_FIRE_SCORE = 1;

// frontmatter: a cover page is short because it IS the title/version/date stamp and little else.
// All four conditions below are required, not just weighted, because a real early-page paragraph
// that happens to carry the same fused version+date footer as a cover (measured across this
// corpus) is common and must not be caught. The length cap is what actually separates the two in
// practice: real cover stubs measured at ~100 characters, while the shortest real early-page
// content block carrying a version+date footer still measured 600+ characters.
const FRONTMATTER_EARLY_PAGE_MAX = 3;
const FRONTMATTER_MAX_LENGTH = 300;
const FRONTMATTER_MAX_DENSITY = 0.3; // sentence terminators per 100 chars; measured cover stubs at 0.0
const FRONTMATTER_SCORE_THRESHOLD = 0.5;
const FRONTMATTER_VERSION_RE = /version\s+\d/i;
const FRONTMATTER_DATE_RE =
	/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:19|20)\d{2}\b/i;
// A sentence terminator requires a real word (2+ letters) immediately before the punctuation, so
// a single-letter abbreviation ("U.S.") or a decimal ("6.0") is not mistaken for a sentence end -
// both are common in a cover stamp and would otherwise make it look like it has real prose.
const SENTENCE_TERMINATOR_RE = /[a-zA-Z]{2,}[.!?](?=\s|$)/g;

/** Fraction of the block that reads as a dense list of title-plus-page-number entries. */
function scoreToc(text: string): number {
	const dottedLeaders = (text.match(/\.{3,}/g) || []).length;
	const tokens = text.split(/\s+/).filter((t) => t.length > 0);
	const pageNumberTokens = tokens.filter((t) => /^\d{1,3}$/.test(t)).length;

	if (!TOC_CONTENTS_MARKER_RE.test(text)) {
		// No "Contents" marker: only unambiguous dotted-leader density can fire here (a multi-page
		// contents section's continuation pages carry no marker of their own), AND only when the leaders
		// are corroborated by matching page numbers - otherwise a dotted fill-in worksheet would drop.
		if (dottedLeaders < TOC_MARKERLESS_MIN_DOTTED_LEADERS) return 0;
		if (pageNumberTokens < dottedLeaders * TOC_MARKERLESS_MIN_PAGE_NUMBER_RATIO) return 0;
		const magnitude = Math.min(1, dottedLeaders / (TOC_MARKERLESS_MIN_DOTTED_LEADERS * 2));
		return TOC_MARKERLESS_BASE_SCORE + (1 - TOC_MARKERLESS_BASE_SCORE) * magnitude;
	}

	const fraction = pageNumberTokens / tokens.length;

	if (fraction < TOC_TOKEN_FRACTION_THRESHOLD && dottedLeaders < TOC_MIN_DOTTED_LEADERS) return 0;

	const fractionSignal = Math.min(1, fraction / (TOC_TOKEN_FRACTION_THRESHOLD * 2));
	const dottedSignal = Math.min(1, dottedLeaders / (TOC_MIN_DOTTED_LEADERS * 2));
	return 0.5 + 0.5 * Math.max(fractionSignal, dottedSignal);
}

/** Whether the block is the standalone DoD/VA disclaimer paragraph, not just a mention of one. */
function scoreDisclaimer(text: string): number {
	return DISCLAIMER_PHRASE_RE.test(text) ? DISCLAIMER_FIRE_SCORE : 0;
}

/** How strongly the block reads as a cover/version stamp rather than a real paragraph. */
function scoreFrontMatter(text: string, page: number | undefined): number {
	if (page === undefined || page > FRONTMATTER_EARLY_PAGE_MAX) return 0;
	if (text.length > FRONTMATTER_MAX_LENGTH) return 0;
	if (!FRONTMATTER_VERSION_RE.test(text) || !FRONTMATTER_DATE_RE.test(text)) return 0;

	const terminators = (text.match(SENTENCE_TERMINATOR_RE) || []).length;
	const density = (terminators / text.length) * 100;
	if (density > FRONTMATTER_MAX_DENSITY) return 0;

	return 0.5 + 0.5 * (1 - density / FRONTMATTER_MAX_DENSITY);
}

/**
 * Classifies a single extracted block as real content or a whole-block boilerplate class (a
 * table of contents, the standard disclaimer, or cover/front-matter). Only the highest-scoring
 * non-content signal is considered, and only if it clears its own threshold; every threshold is
 * tuned so a block that reads as real prose - even one that mentions a version number, sits on an
 * early page, or contains a stray number - falls through to content rather than being dropped.
 *
 * Args:
 *     block: The extracted block to classify. Only `text` and `page` are read.
 *
 * Returns:
 *     The winning kind plus a confidence in [0, 1]. For a non-content kind, confidence reflects
 *     how strongly that kind's signal fired. For content, confidence reflects how far below every
 *     non-content threshold the block sat (1 when no signal fired at all).
 */
export function classifyBlock(block: Block): Classification {
	const text = block.text;
	const tocScore = scoreToc(text);
	const disclaimerScore = scoreDisclaimer(text);
	const frontMatterScore = scoreFrontMatter(text, block.page);

	const tocFires = tocScore >= TOC_SCORE_THRESHOLD;
	const disclaimerFires = disclaimerScore >= DISCLAIMER_SCORE_THRESHOLD;
	const frontMatterFires = frontMatterScore >= FRONTMATTER_SCORE_THRESHOLD;

	if (!tocFires && !disclaimerFires && !frontMatterFires) {
		return {
			kind: 'content',
			confidence: 1 - Math.max(tocScore, disclaimerScore, frontMatterScore)
		};
	}

	// Only a fired score can win: un-fired scores are floored to -1 before comparing magnitudes,
	// so picking the strongest signal is a single Math.max call with no hand-written tie-break.
	const best = Math.max(
		tocFires ? tocScore : -1,
		disclaimerFires ? disclaimerScore : -1,
		frontMatterFires ? frontMatterScore : -1
	);
	if (best === tocScore) return { kind: 'toc', confidence: tocScore };
	if (best === disclaimerScore) return { kind: 'disclaimer', confidence: disclaimerScore };
	return { kind: 'frontmatter', confidence: frontMatterScore };
}
