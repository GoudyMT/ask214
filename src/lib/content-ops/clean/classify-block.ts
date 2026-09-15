import type { Block } from '$lib/content-ops/extract/pdf-text';

export type BlockKind = 'content' | 'toc' | 'disclaimer' | 'frontmatter' | 'exercise' | 'chrome';

// chrome: a navigation or feedback widget the page template prints around its content. It answers nothing
// and is embedded and retrievable like any other block.
//
// Matched as the WHOLE block, trimmed and case-folded, against exact literals - never by length and never
// as a substring. Enumerating the 51 shortest chunks in this corpus is what forced that: almost all of
// them are real content, including VGLI premium rows ("Ages 30 to 34"), application steps ("Option 1:
// Apply online") and ordinary section headings ("Preferred providers"). A length rule would delete every
// one of them, and a substring rule would condemn any sentence that happens to quote a widget's wording.
const CHROME_BLOCKS = new Set([
	'was this page helpful?',
	'related articles',
	'related information',
	'related benefits & services',
	'browse by topic'
]);
export type Classification = { kind: BlockKind; confidence: number };

// exercise: a graded classroom exercise - a multiple-choice question bank, a true/false statement bank,
// or the answer key to one. This is the only class in this corpus where the app can state something FALSE
// while quoting the source perfectly, because a distractor is wrong by construction and a true/false
// statement is a claim the reader is meant to JUDGE, not believe. Chunking makes it worse rather than
// better: it splits the "decide whether it is true or false" framing off the statements, so the statements
// render as the document's own plain declarative prose.
//
// Anchored on the exercise FORM, never on a topic word - a rule keyed on "Capstone" would destroy 18
// legitimate chunks including the passage answering what a Capstone is, and detecting a run of lettered
// options matched 9 blocks of which 4 were worksheet sub-lists ("a. Skills b. Education and Training c.
// Credentials"), a 44% false-positive rate on real content.
//
// A THIRD anchor was removed after it destroyed real content. It matched an appendix whose title contains
// QUIZ, which is a topic word in a title rather than a form - the exact shape this design rejects. It
// caught two blocks and neither was a graded exercise: a contents page that merely LISTS such an appendix,
// and a prose answer key whose corrections were the corpus's only source for how far back a work history
// should go and that age and marital status do not belong on a resume. The graded material it was meant to
// reach is caught by the two anchors below on its own form, so removing it lost no coverage. A block that
// cites an appendix is not that appendix.
//
// 1. The column header the VA guide prints above its question bank and above its answer-key grid. The
//    header is followed immediately by the first column - a module number in the quiz, "Number Answer" in
//    the key - which is what separates the header from a participant guide discussing its own modules in
//    ordinary prose.
const EXERCISE_QUESTION_BANK_RE = /Module Question\s+(?:Module\s+\d|Number\s+Answer)/i;
// 2. A numbered activity whose title says QUIZ, and which OPENS the block. Position is load-bearing: the
//    same marker TRAILING a block means the block is real content that merely ends in an exercise, which
//    strip-exercise.ts cuts instead. Requiring the number keeps ordinary worksheets ("ACTIVITY: Gap
//    Analysis") out, and requiring QUIZ keeps the other 44 numbered activities out.
const EXERCISE_ACTIVITY_HEAD_RE = /^\s*ACTIVITY\s+[\d.]+\s*:\s*[^\n]{0,40}QUIZ/i;
// These are exact document-structure literals rather than a weighted heuristic, so a match is certain
// rather than probable. Firing at 1 clears the orchestrator's auto-drop cutoff with no borderline lane -
// there is nothing for a human to adjudicate about a block that titles itself an answer key.
const EXERCISE_FIRE_SCORE = 1;
const EXERCISE_SCORE_THRESHOLD = 0.5;

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
// Some guides' contents pages index appendices with an appendix-style reference ("A-160", "B-111")
// in place of a bare page number, so the bare-\d{1,3} signal alone scored them near zero and kept
// them as content. This counts a single capital letter + hyphen + 1-3 digit page number as a page
// reference too. The word boundary plus single [A-Z] is the guard: it excludes multi-letter acronyms
// ("MGIB-AD", "COVID-19") and a footer stamp glued mid-word ("GuideA-160"), so only a standalone
// appendix reference counts.
const TOC_APPENDIX_REF_RE = /\b[A-Z]-\d{1,3}\b/g;

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
	const appendixRefs = (text.match(TOC_APPENDIX_REF_RE) || []).length;
	// A page reference is either a bare page number or an appendix-style reference; a contents page is
	// dense with them regardless of which form a given guide uses.
	const pageRefs = pageNumberTokens + appendixRefs;

	if (!TOC_CONTENTS_MARKER_RE.test(text)) {
		// No "Contents" marker: only unambiguous dotted-leader density can fire here (a multi-page
		// contents section's continuation pages carry no marker of their own), AND only when the leaders
		// are corroborated by matching page references - otherwise a dotted fill-in worksheet would drop.
		if (dottedLeaders < TOC_MARKERLESS_MIN_DOTTED_LEADERS) return 0;
		if (pageRefs < dottedLeaders * TOC_MARKERLESS_MIN_PAGE_NUMBER_RATIO) return 0;
		const magnitude = Math.min(1, dottedLeaders / (TOC_MARKERLESS_MIN_DOTTED_LEADERS * 2));
		return TOC_MARKERLESS_BASE_SCORE + (1 - TOC_MARKERLESS_BASE_SCORE) * magnitude;
	}

	const fraction = pageRefs / tokens.length;

	if (fraction < TOC_TOKEN_FRACTION_THRESHOLD && dottedLeaders < TOC_MIN_DOTTED_LEADERS) return 0;

	const fractionSignal = Math.min(1, fraction / (TOC_TOKEN_FRACTION_THRESHOLD * 2));
	const dottedSignal = Math.min(1, dottedLeaders / (TOC_MIN_DOTTED_LEADERS * 2));
	return 0.5 + 0.5 * Math.max(fractionSignal, dottedSignal);
}

/** Whether the block is the standalone DoD/VA disclaimer paragraph, not just a mention of one. */
function scoreDisclaimer(text: string): number {
	return DISCLAIMER_PHRASE_RE.test(text) ? DISCLAIMER_FIRE_SCORE : 0;
}

/** Whether the block IS a graded exercise or its answer key, judged by the guide's own structural
 *  labels rather than by topic - so prose about a real quiz a veteran can go and take is untouched. */
function scoreExercise(text: string): number {
	const isExercise = EXERCISE_QUESTION_BANK_RE.test(text) || EXERCISE_ACTIVITY_HEAD_RE.test(text);
	return isExercise ? EXERCISE_FIRE_SCORE : 0;
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
	// Whole-block equality, so this is a decision rather than a score: either the block IS the widget or
	// it is not, and there is nothing partial to weigh against the heuristics below.
	if (CHROME_BLOCKS.has(text.trim().toLowerCase())) return { kind: 'chrome', confidence: 1 };

	const tocScore = scoreToc(text);
	const disclaimerScore = scoreDisclaimer(text);
	const frontMatterScore = scoreFrontMatter(text, block.page);
	const exerciseScore = scoreExercise(text);

	const tocFires = tocScore >= TOC_SCORE_THRESHOLD;
	const disclaimerFires = disclaimerScore >= DISCLAIMER_SCORE_THRESHOLD;
	const frontMatterFires = frontMatterScore >= FRONTMATTER_SCORE_THRESHOLD;
	const exerciseFires = exerciseScore >= EXERCISE_SCORE_THRESHOLD;

	if (!tocFires && !disclaimerFires && !frontMatterFires && !exerciseFires) {
		return {
			kind: 'content',
			confidence: 1 - Math.max(tocScore, disclaimerScore, frontMatterScore, exerciseScore)
		};
	}

	// Only a fired score can win: un-fired scores are floored to -1 before comparing magnitudes,
	// so picking the strongest signal is a single Math.max call with no hand-written tie-break.
	const best = Math.max(
		tocFires ? tocScore : -1,
		disclaimerFires ? disclaimerScore : -1,
		frontMatterFires ? frontMatterScore : -1,
		exerciseFires ? exerciseScore : -1
	);
	// Exercise is tested first because it is the only kind whose blocks can assert a FALSEHOOD; the
	// others are merely non-answering. On a tie at the same score, that is the one to act on.
	if (best === exerciseScore) return { kind: 'exercise', confidence: exerciseScore };
	if (best === tocScore) return { kind: 'toc', confidence: tocScore };
	if (best === disclaimerScore) return { kind: 'disclaimer', confidence: disclaimerScore };
	return { kind: 'frontmatter', confidence: frontMatterScore };
}
