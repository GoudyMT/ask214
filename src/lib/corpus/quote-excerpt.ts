/**
 * Sentence-bounded excerpt trimming for the QUOTED result-card lead.
 *
 * The card presents the excerpt as a quotation from the source document, so it must never end
 * mid-clause: a quote cut at an arbitrary word is not a quote, and reads as the mangled extracted
 * text this display path exists to stop showing. So the budget is honoured by dropping whole
 * sentences, not by cutting one.
 *
 * Pure + browser-safe. Runs AFTER cleanExcerpt (which removes extraction artifacts); this only
 * bounds length. No lookbehind assertions - iOS Safari gained them in 16.4 and this ships to a PWA.
 */

// Abbreviations whose trailing period is not a sentence end. Single letters cover initials and the
// dotted forms this corpus uses constantly ("10 U.S.C. 1144", "the U.S. Department of War").
const ABBREVIATIONS = new Set([
	'mr',
	'mrs',
	'ms',
	'dr',
	'jr',
	'sr',
	'st',
	'vs',
	'no',
	'sec',
	'fig',
	'dept',
	'est',
	'inc',
	'corp',
	'co',
	'ltd',
	'approx',
	'eg',
	'ie',
	'etc',
	'al',
	'us',
	'usc',
	'cfr'
]);

/** True when `piece` ends in an abbreviation, so its final period is not a sentence boundary. */
function endsWithAbbreviation(piece: string): boolean {
	// Take the last whitespace-delimited token and strip its dots: "U.S.C." -> "usc", "Dr." -> "dr".
	const token = piece.trim().split(/\s+/).pop() ?? '';
	const bare = token.replace(/[.]/g, '').toLowerCase();
	if (bare.length === 0) return false;
	// A single letter is an initial ("J. Smith"), never a sentence end.
	if (bare.length === 1) return true;
	return ABBREVIATIONS.has(bare);
}

/**
 * Splits text into sentences. A boundary is terminal punctuation followed by whitespace and an
 * opening character (capital, quote, or paren) - so decimals and reference numbers ("14.629",
 * "823.261-026") never split, and an abbreviation guard keeps "10 U.S.C. 1144" whole.
 *
 * Args:
 *     text: display-clean text to split.
 *
 * Returns:
 *     The sentences in order, each trimmed. Text with no boundary yields a single element.
 */
export function splitSentences(text: string): string[] {
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch !== '.' && ch !== '!' && ch !== '?') continue;
		let j = i + 1;
		while (j < text.length && /\s/.test(text[j] ?? '')) j++;
		if (j === i + 1) continue; // no whitespace after the stop - inside a number or a URL
		if (j >= text.length) break; // trailing punctuation; the tail below captures it
		const next = text[j] ?? '';
		// cleanExcerpt renders PDF bullet glyphs as " - ", so a list trailing a sentence opens a new
		// segment too - otherwise the whole list is absorbed into the sentence and the quote runs on.
		const opensList = next === '-' && /\s/.test(text[j + 1] ?? '');
		if (!opensList && !/[A-Z"(]/.test(next)) continue; // next sentence must open properly
		if (endsWithAbbreviation(text.slice(start, i))) continue;
		const sentence = text.slice(start, i + 1).trim();
		if (sentence) out.push(sentence);
		start = j;
	}
	const tail = text.slice(start).trim();
	if (tail) out.push(tail);
	return out;
}

/**
 * The three numbers that shape a quoted lead. They do different jobs, and conflating them is what
 * makes a card either a wall of text or a broken fragment.
 */
export type QuoteBudget = {
	/** Word budget for ACCUMULATING whole sentences. Results are commonly well under it. */
	target: number;
	/**
	 * A single sentence may run this long to stay WHOLE rather than be truncated. Defaults to
	 * `target` (a hard cap). Measured on this corpus: a 45 ceiling against a 30 target lifts complete
	 * quotations from 52% to 67% of cards for about one extra word on average.
	 */
	ceiling?: number;
	/**
	 * Below this there is no quotable passage, so the result is '' and the card shows its citation
	 * alone rather than quoting a bare section header as though it were a passage. Defaults to 0.
	 */
	min?: number;
};

/** True for a segment that opens with cleanExcerpt's " - " list separator rather than prose. */
function isListSegment(s: string): boolean {
	return /^-\s/.test(s.trim());
}

function wordCount(s: string): number {
	const t = s.trim();
	return t.length === 0 ? 0 : t.split(/\s+/).length;
}

// Longest ordinary word we expect in this corpus; past it a token is a URL or an extraction run, and
// budgeting it as a single "word" is what lets one link occupy a whole card.
const LONG_TOKEN_CHARS = 12;

/** Budget cost of a token: ordinary words cost 1, an over-long one costs its share of the line. */
function tokenWeight(token: string): number {
	return Math.max(1, Math.ceil(token.length / LONG_TOKEN_CHARS));
}

/**
 * What a passage COSTS to display, as opposed to how many words it contains. A printed URL is real
 * document content and is never deleted from a quotation, but it occupies space far beyond its single
 * word - measured on this corpus, URL-bearing quotes reached 641 characters against a 358 maximum
 * elsewhere. Budgeting by weight bounds the card without editing the source's words.
 */
function visualWeight(s: string): number {
	const t = s.trim();
	if (t.length === 0) return 0;
	return t.split(/\s+/).reduce((sum, token) => sum + tokenWeight(token), 0);
}

/**
 * Trims text to whole sentences within a word budget, for display as a quotation.
 *
 * Args:
 *     text: display-clean excerpt text (post-cleanExcerpt).
 *     budget: see QuoteBudget - target bounds accumulation, ceiling rescues one long sentence from
 *         truncation, min suppresses a quote with no substance.
 *
 * Returns:
 *     The longest run of leading WHOLE sentences that fits the budget, or '' when that is shorter
 *     than `min`. When even the first sentence exceeds the ceiling it is word-truncated to `target`
 *     with a trailing ellipsis - the ellipsis is what keeps a shortened quote honest about being
 *     shortened.
 */
export function quoteExcerpt(text: string, budget: QuoteBudget): string {
	const min = budget.min ?? 0;
	const quote = buildQuote(text, budget.target, budget.ceiling ?? budget.target, min);
	return wordCount(quote) >= min ? quote : '';
}

function buildQuote(
	text: string,
	maxWords: number,
	ceilingWords: number,
	minWords: number
): string {
	const trimmed = text.trim();
	if (trimmed.length === 0 || maxWords <= 0) return '';

	const sentences = splitSentences(trimmed);
	const kept: string[] = [];
	let used = 0;
	for (const sentence of sentences) {
		// A quotation is PROSE, so the quote ends where a converted bullet list begins - but only once
		// the prose already stands on its own. A chunk opening with a short header ("Did You Know?")
		// followed by a bulleted PARAGRAPH would otherwise yield a 3-word quote and be suppressed,
		// while its real content sat in the very next segment.
		const isList = isListSegment(sentence);
		if (isList && used >= minWords) break;
		const piece = isList ? sentence.replace(/^-\s*/, '') : sentence;
		const n = visualWeight(piece);
		// The FIRST sentence may run to the ceiling so it survives whole - chopping a 31-word sentence
		// to 30 pays a broken quotation to save one word. Every LATER sentence is optional extra
		// content, so it must fit the target; the ceiling is a rescue, not a licence to run long.
		const allowance = kept.length === 0 ? ceilingWords : maxWords;
		if (used + n > allowance) break;
		kept.push(piece);
		used += n;
	}
	if (kept.length > 0) return kept.join(' ');

	// No whole sentence fits: keep the quote honest by marking the cut. Tokens are taken while the
	// budget holds and the cut lands BETWEEN tokens - slicing through a URL would render an unreadable
	// fragment and misrepresent what the document says, so an over-long token is left out entirely and
	// the ellipsis reports that the passage was shortened.
	const taken: string[] = [];
	let spent = 0;
	for (const token of (sentences[0] ?? trimmed).split(/\s+/)) {
		const w = tokenWeight(token);
		if (spent + w > maxWords) break;
		taken.push(token);
		spent += w;
	}
	// Always keep at least one token, so a lone over-long URL still yields a marked, non-empty quote.
	if (taken.length === 0) taken.push((sentences[0] ?? trimmed).split(/\s+/)[0] ?? '');
	// A cut can land on a trailing separator or punctuation (cleanExcerpt renders bullet glyphs as
	// " - "), so strip that AND its whitespace - otherwise it reads as "...w22 ..." not "...w22...".
	return taken.join(' ').replace(/[\s,;:.-]+$/, '') + '...';
}
